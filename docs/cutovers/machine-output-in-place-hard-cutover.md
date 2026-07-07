# Machine output leaves its drawers — intelligence renders in the surfaces it describes — Hard Cutover

**Status:** Spec · Rev 1 · 2026-07-07
**Type:** Hard cutover — no legacy code, no fallbacks, no compat shims, no flags-for-old-behavior. The secondary-drawer surfaces are deleted, not toggled.

## One-line

The library brief and a page's connections are machine-authored artifacts demoted to opt-in secondary drawers you must remember exist. Delete the two drawers — the `library-tools`/`Intelligence` and `notes-tools`/`Connections` secondary surfaces — and render their content **in place**: the dossier as a quiet typeset brief above the entry list on the library it describes, the resonance connections as a foot-of-page apparatus on the page they belong to. The reader is out of scope (sibling #8 owns it).

---

## 0. Prerequisites (hard, no fallback)

- **P-1. Sibling #1 `machine-hand-hard-cutover.md` lands first.** Both re-homed artifacts render machine voice: the dossier body/lede through `MachineText` block (`origin="Dossier"`), the Synapse rationale through `MachineText` inline (`origin="Synapse"`). #1's adoption map (`machine-hand-hard-cutover.md` §7.2) **already** wraps the two exact sites this cutover relocates — `LibraryIntelligencePane.tsx:351-357` `.intelligenceBody` and `ConnectionsSurface.tsx:307-311` — so #10 *moves* those `MachineText` usages, it does not author them. The slate fixes the order (#1 before #10). If #10 shipped first, the two artifacts would render in warm Inter as a temporary defect, not a design choice.
- **P-2. The LI SSE plane is untouched.** The dossier build streams over `useGenerationRun<LiStreamEvent>({ kind: "library-intelligence" })` → `/stream/library-intelligence/{revision_id}/events` (`lib/api/useGenerationRun.ts:15,33`; `GENERATION_RUN_STREAM_PATHS["library-intelligence"] = "/stream/library-intelligence"`), decoded by `useLibraryIntelligenceStream` into `{ building, progress, generate, subscribe }` (`components/library/useLibraryIntelligenceStream.ts`). This cutover **re-hosts** the consumer of that hook; it changes no SSE path, token mint, decode, or backend event (D-8).
- **P-3. The secondary-pane model is the sole surface registry.** `PANE_SECONDARY_SURFACE_DEFINITIONS` + `PANE_SECONDARY_GROUP_BASE` in `lib/panes/paneSecondaryModel.ts` are `satisfies`-typed; `WorkspaceSecondarySurfaceId`/`WorkspaceSecondaryGroupId`/`PaneSecondaryIconId` **derive** from the const arrays. Removing an entry narrows the union, turning every literal reference into a compile error — the sweep is compiler-driven, not grep-hoped.
- **P-4. Workspace restore already degrades gracefully.** `sanitizeAttachedSecondaryPane` (`lib/workspace/schema.ts:209-217`) drops a stored secondary pane whose `groupId`/`activeSurfaceId` fails `isWorkspaceSecondaryGroupId` / `isWorkspaceSecondarySurfaceId`. Deleting the two groups/surfaces makes a persisted `"library-intelligence"` / `"notes-connections"` state fall away on restore — no migration, no crash.

> Rationale: this is a frontend-led re-home. Every backend capability is unchanged — the artifact API (`/api/libraries/{id}/intelligence*`), the connections API (`resource_graph` / `synapse`), the SSE plane, the workers. The value is deleting two drawers and the demotion they encode.

---

## 1. Problem (grounded diagnosis)

Nexus's thesis is the machine as **co-author**. Two of its most co-authored artifacts are hidden behind tabs a user must remember to open:

### 1.1 The library brief is a drawer

`LibraryPaneBody.tsx` publishes the dossier as a secondary surface: `usePaneSecondary(secondaryDescriptor)` (`:798-814`) registers a `groupId: "library-tools"`, `defaultSurfaceId: "library-intelligence"` publication whose body is `<LibraryIntelligencePane libraryId={id} />`. It opens only on demand — the "Intelligence" pane-options item (`libraryResourceOptions` → `onViewIntelligence` → `requestSecondarySurface?.("library-intelligence")`, `:715-717`), a `?tab=intelligence` effect (`:718-722`), or the Libraries **index** row action which deep-links via `openInNewPane(href, name, "library-intelligence")` (`LibrariesPaneBody.tsx:285-290`; the 3rd arg is `secondarySurfaceId`, `paneRuntime.tsx:75-79`). Until one of those fires, the synthesized brief of the library you are looking at is invisible. `LibraryIntelligencePane.tsx` is an 857-line god-component holding the stream driver, artifact/revision fetches, status/coverage/model metadata, the generate form, the citations body, the revision history, and an inline pane-swapping mini-chat.

### 1.2 A page's connections are a drawer

`PagePaneBody.tsx` (`:703-721`) and `NotePaneBody.tsx` (`:177-195`) each publish `usePaneSecondary({ groupId: "notes-tools", defaultSurfaceId: "notes-connections", … <ConnectionsSurface …/> })` and open it via a "Show connections" pane option (`requestSecondarySurface?.("notes-connections")`, `PagePaneBody.tsx:681`, `NotePaneBody.tsx:169`). `DailyNotePaneBody.tsx` renders `PagePaneBody` (`:112,118`), so daily pages inherit the same drawer. The Synapse resonance engine writes agent connections onto every page as it settles (`synapse-resonance-engine.md` §7), then files them in a tab. **`ConnectionsSurface` is imported by exactly two files — `PagePaneBody.tsx` and `NotePaneBody.tsx`** (verified); the reader's connections are a different component (`ReaderDocumentMapConnectionsLens`, sibling #8). So `notes-connections` is a self-contained notes concern this cutover can fully re-home.

### 1.3 The structural flaw

Both surfaces share one wrong default: **machine output is opt-in.** A secondary drawer is the correct home for a *tool* (Contents, a citation lens, a fork list); it is the wrong home for the machine's *authored contribution to the thing you are reading*. The brief belongs on the library; the connections belong on the page. The drawer is the demotion.

---

## 2. Target behavior (user-facing)

- **The library shows its brief in place.** Opening a library shows, above the entry list, a quiet typeset **brief**: a machine-set lede (the dossier's opening, `MachineText` block, signed `DOSSIER · <generated>`) with a single "Read the full dossier" expander. Expanded, it is the full synthesis with its citations, staleness/coverage line, an inline Regenerate control, and a "Dossier history" disclosure. No tab. No card. No badge.
- **A library with no dossier is silent.** No brief, no skeleton, no placeholder prose — just the entry list, plus **one** quiet, non-machine-voiced "Generate dossier" text button. Nothing is auto-generated.
- **Generation is unchanged and live.** Regenerate/Generate streams exactly as today (SSE); the brief shows `Generating…` progress in place and settles to the new revision. Opening a library mid-build resumes the stream in place.
- **A page shows its connections in place.** Below the page/note body, a foot-of-page **Connections** apparatus lists what this page is connected to — human links and citations, and Synapse's resonance proposals set in the machine hand with a one-line rationale and a dismiss (`×`, "won't be suggested again"). The scan and the manual "Connect/Attach" affordances live in the apparatus header, quiet by default.
- **Deep links still work.** `/libraries/{id}?tab=intelligence` opens the library with the brief auto-expanded and scrolled to; `?tab=intelligence&revision={id}` shows that historical revision inline.
- **Mobile is simpler.** The two secondary tabs are gone; the brief and the connections scroll inline in the pane body. One fewer place to reach.

---

## 3. Goals / Non-goals

### Goals

- **G1.** Delete the `library-tools`/`library-intelligence` and `notes-tools`/`notes-connections` secondary surfaces + groups from `paneSecondaryModel.ts`, and the `secondaryGroups` route bindings that reference them.
- **G2.** Render the dossier inline in `LibraryPaneBody`, above the entry list, as a present-but-quiet expandable brief (D-1); decompose the 857-line `LibraryIntelligencePane` into section-sized owners (§7.1).
- **G3.** Render page connections inline in `PagePaneBody`/`NotePaneBody` as a foot-of-page apparatus (D-5), re-homing `ConnectionsSurface` from drawer to body.
- **G4.** Move generation / refresh / staleness controls inline; keep the SSE/stream path byte-identical (G-anchor: `useLibraryIntelligenceStream` + `useGenerationRun` unchanged).
- **G5.** Empty library = silence: no machine-voiced content, at most one quiet generate affordance (D-2); no skeleton theater.
- **G6.** Sweep every caller, deep link, and test of the removed surfaces/groups with grep evidence (§9, §13).

### Non-goals

- **N1. The reader is excluded.** `reader-connections` / `reader-apparatus` / `reader-highlights` are `reader-tools`; sibling #8 (`reader-sidecar-consolidation-hard-cutover.md`) owns the reader end-state. This cutover does not touch the `reader-tools` group or `MediaPaneBody`'s connection lenses.
- **N2. No backend, no migration, no API change.** No route, no worker, no `resource_edges`/`synapse_suppressions`/artifact-table change, no `API_ROUTE_COUNT` bump. Purely frontend re-home (D-8).
- **N3. No machine-voice typography here.** `MachineText`, `--font-machine`, `--ink-machine`, and the signature are owned by sibling #1; this cutover *composes* them (P-1). It defines no token and authors no `MachineText`.
- **N4. No new connection kinds/origins, no new dossier fields.** The lede is derived client-side from `content_md`; the connections apparatus renders the existing `queryConnections` result.
- **N5. No conversation-context or forks change.** The `conversation-context` group (`conversation-context-refs`, `conversation-forks`) is a genuine tool sidecar, not machine output; untouched.
- **N6. No page-furniture work.** `RunningHead`/`SectionOpener` (sibling #2) are human editorial furniture and explicitly do not render machine output (`running-journal-hard-cutover.md` N2). The brief is *not* a `SectionOpener`; it is a `MachineText` block. Coordination only (§10).

---

## 4. Architecture and final state

### 4.1 Ownership map

| Concern | Sole owner (final) | Replaces |
|---|---|---|
| Where the dossier lives | `LibraryPaneBody` body, above the entry list | `usePaneSecondary` `library-intelligence` drawer |
| Dossier inline owner (stream + data + expand + silence) | `components/library/LibraryBrief.tsx` | `LibraryIntelligencePane.tsx` (deleted) |
| Dossier lede / full body / controls / revisions | `LibraryBriefLede`, `LibraryBriefArtifact`, `LibraryBriefControls`, `LibraryBriefRevisions` (§7.1) | the 5 inner components inside `LibraryIntelligencePane.tsx` |
| Dossier lede derivation | `lib/library/dossierLede.ts` (`deriveDossierLede`) | (new; a rendering concern) |
| Where a page's connections live | `PagePaneBody`/`NotePaneBody` body, below the editor | `usePaneSecondary` `notes-connections` drawer |
| Connections apparatus | `components/connections/ConnectionsSurface.tsx` (re-homed inline, quiet-composer) | the drawer publication of the same component |
| SSE build transport | `useLibraryIntelligenceStream` + `useGenerationRun` | **unchanged** (P-2, D-8) |
| Secondary surface registry | `lib/panes/paneSecondaryModel.ts` (minus 2 groups, 2 surfaces) | its current 4-group / 10-surface shape |

### 4.2 Final `paneSecondaryModel.ts` shape

`PANE_SECONDARY_GROUP_BASE` loses `"library-tools"` and `"notes-tools"` → keeps `"reader-tools"` and `"conversation-context"`. `PANE_SECONDARY_SURFACE_DEFINITIONS` loses `library-intelligence` (`:83-87`) and `notes-connections` (`:89-93`) → 10 surfaces become 8. `WorkspaceSecondaryGroupId`, `WorkspaceSecondarySurfaceId`, and `PaneSecondaryIconId` narrow automatically via `satisfies` (P-3). `paneRouteModel.ts` drops `secondaryGroups: ["library-tools"]` from `library` (`:107`) and `secondaryGroups: ["notes-tools"]` from `page` (`:207`), `note` (`:216`), `daily` (`:225`), `dailyDate` (`:234`).

> Sibling #8 removes different entries from the **same file** (five `reader-tools` surfaces — Highlights, Embeds, Citations, Connections, Chat — and adds one new `reader-evidence`). Disjoint keys; §10 covers merge order.

### 4.3 The library brief in place

`LibraryPaneBody` renders `<LibraryBrief libraryId={id} />` in its body, between the membership panel and the `<PaneSurface>` entry list. `LibraryBrief` is the single inline owner:

```
LibraryBrief (owner: artifact resource + useLibraryIntelligenceStream + expand + tab/revision params)
 ├─ status "unavailable" & no content → renders LibraryBriefControls' lone "Generate dossier" button (silence, D-2)
 ├─ status "building"                 → LibraryBriefControls (Generating… progress) + streaming lede
 └─ artifact present                  → LibraryBriefLede (collapsed)  ──expand──▶  LibraryBriefArtifact
                                        + LibraryBriefControls (staleness · coverage · Regenerate)
                                        + LibraryBriefRevisions (disclosure)
```

- **Collapsed (default, present-but-quiet — binding (b)):** `LibraryBriefLede` renders `deriveDossierLede(content_md)` through `MachineText` block (`origin="Dossier"`, `timestamp` = generated time), plus a "Read the full dossier" expander. A quiet staleness cue (`Stale — N sources changed`) sits on the same line when stale. **ARIA:** the expander is a `<button aria-expanded={expanded} aria-controls={fullBodyId}>`; the revealed `LibraryBriefArtifact` region carries `id={fullBodyId}` — the same disclosure contract already used at `LibraryIntelligencePane.tsx:737` (`aria-expanded`) for the history toggle.
- **Expanded:** `LibraryBriefArtifact` renders the full `content_md` via `MarkdownMessage` (citations, `toReaderCitationData`, `dispatchReaderSourceActivation`) inside one `MachineText` block; `LibraryBriefRevisions` (the disclosure) and the Regenerate control follow.
- **Deep link:** `usePaneSearchParams().get("tab") === "intelligence"` → start expanded + `scrollIntoView`; `?revision={id}` → expanded, showing that revision inline (the existing `/api/libraries/{id}/intelligence/revisions/{id}` fetch).

### 4.4 The page connections in place

`PagePaneBody` and `NotePaneBody` stop publishing `usePaneSecondary`; each renders `<ConnectionsSurface objectRef=… onOpenRoute=… />` as a **footer** inside the editor shell, below `ProseMirrorOutlineEditor`, separated by a hairline rule. `DailyNotePaneBody` inherits it through `PagePaneBody`. Footer, not margin — see D-5.

`ConnectionsSurface` is re-homed with a **quiet composer**: the `ConnectionComposer` (Connect/Attach) collapses behind a single "＋ Connect" disclosure in the apparatus header (`Sparkles` scan button stays for scannable refs). The rows render as today — user/citation/note-body edges plain; `origin="synapse"` rows keep the `✦` marker + dismiss (`×`) and render their `rationale` through `MachineText` inline (`origin="Synapse"`, adopted by #1). When there are no connections and the composer is collapsed, the apparatus is a single hairline label at most — no form under every page.

---

## 5. Data model / migration

**None.** No table, no column, no Alembic revision. The dossier artifact/revision schema, `resource_edges`, `synapse_suppressions`, and every worker are unchanged (N2). The lede is derived at render time from the artifact's existing `content_md`.

## 6. API

**None.** No new or changed route, no BFF proxy, no `success_response` shape, no `API_ROUTE_COUNT` change. The brief reads the existing `GET /api/libraries/{id}/intelligence`, `…/intelligence/revisions`, `…/revisions/{id}`, `POST …/intelligence/generate`, `POST …/revisions/{id}/promote`; the connections apparatus reads the existing `queryConnections` / `synapse` endpoints. SSE `/stream/library-intelligence/{revision_id}/events` is unchanged (P-2).

---

## 7. Frontend

### 7.1 Library brief — named component map (decompose the 857-line pane — binding (b))

New directory `components/library/` (co-located with the existing `useLibraryIntelligenceStream.ts`). Each owner is section-sized; the current `LibraryIntelligencePane.tsx` internals map onto them 1:1.

| Component | File | Responsibility | Absorbs (from `LibraryIntelligencePane.tsx`) |
|---|---|---|---|
| `LibraryBrief` | `LibraryBrief.tsx` | Owner: artifact `useResource`, `useLibraryIntelligenceStream`, expand state, `tab`/`revision` params, silence gate. Renders nothing machine-voiced when `unavailable` & no content. | the top-level `LibraryIntelligencePane` shell + `useEffect` resume/subscribe (`:114-291`) |
| `LibraryBriefLede` | `LibraryBriefLede.tsx` | Collapsed abstract via `MachineText` block; "Read the full dossier" expander. | (new; consumes `deriveDossierLede`) |
| `LibraryBriefArtifact` | `LibraryBriefArtifact.tsx` | Expanded full body: `MarkdownMessage` (content + citations) inside one `MachineText` block; citation activation. | `.intelligenceBody` render (`:345-358`) + `activate` (`:192-213`) |
| `LibraryBriefControls` | `LibraryBriefControls.tsx` | Inline staleness/coverage/model line + Generate/Regenerate/Retry (streaming aware) + the lone empty-state generate button. | `StatusLine`, `DossierMetadata`, `GenerateDossierForm`, `RevisionStatusLine` (`:373-574`) + the pure helpers `statusLabel`/`statusRole`/`countLabel`/`coverageLabel`/`formatOptionalDate`/`modelSummary`/`previewInstruction` (`:576-655`) |
| `LibraryBriefRevisions` | `LibraryBriefRevisions.tsx` | "Dossier history" disclosure + restore + open-revision deep link. | `RevisionHistory`, `RevisionHistoryItem` (`:662-856`) |

`LibraryBrief.module.css` receives the `.intelligence*` rules (verified used **only** by `LibraryIntelligencePane.tsx`), which are **deleted** from `libraries/[id]/page.module.css`. The badge-ish `.intelligenceHistoryBadge` "Current/Viewing" pills are re-typeset as small-caps text labels (owner taste: no badges).

**Live regions (preserve — binding (b)):** `LibraryBriefControls` must keep the `statusRole` live-region roles — `role="status"` during build/done, `role="alert"` on failure — from `LibraryIntelligencePane.tsx:403` and the per-revision `:436` line, so screen readers still announce generation progress and failure. `visibleCitationCount` (`:607`) moves to `LibraryBrief` (its sole call site is `:277`, inside the shell that becomes `LibraryBrief`).

**Dossier chat (D-6):** the inline pane-swapping mini-chat (`chatOpen` + `ResourceChatDetail`, `:279-291`) is deleted. A quiet "Chat about this dossier" affordance calls `startResourceChat(chatRevisionRef)` then `openInNewPane("/conversations/{id}", "Dossier chat")` — a real conversation pane, matching the resource-chat-subject doctrine (the same pattern #8 uses for the reader). This `startResourceChat` call is a genuinely new codepath (the deleted mini-chat used an inline `ResourceChatDetail`, not an eager start), so the opener follows the same `try/catch` + `setError` pattern as `handleOpenMediaChat` (`LibraryPaneBody.tsx:724-736`): a rejection surfaces a `FeedbackNotice` in the brief (via `handleUnauthenticatedApiError` + `toFeedback`), never a thrown exception or a silently bricked button. `ResourceChatDetail` survives as a generic component; it just loses this call site.

**Lede derivation** (`lib/library/dossierLede.ts`):
```ts
export function deriveDossierLede(contentMd: string): string;
// first non-empty markdown paragraph, stripped of heading/emphasis marks,
// truncated to ~50 words / 320 chars at a word boundary; "" when empty.
```
Pure, unit-tested; no network. Not a new backend field (N4).

### 7.2 Page connections apparatus (binding (c))

- `PagePaneBody.tsx`: delete `secondaryDescriptor` + `usePaneSecondary` (`:703-721`); delete the "Show connections" pane option (`:677-683`); render `<ConnectionsSurface objectRef={backlinkObjectRef} onOpenRoute={openRoute} />` in the editor shell footer (after `ProseMirrorOutlineEditor`, `:743-759`).
- `NotePaneBody.tsx`: delete `secondaryDescriptor` + `usePaneSecondary` (`:177-195`); delete the "Show connections" pane option (`:163-174`); render `<ConnectionsSurface objectRef={{ objectType: "note_block", objectId: blockId }} onOpenRoute={openRoute} />` in the footer.
- `ConnectionsSurface.tsx`: wrap `ConnectionComposer` (`:336-554`) in a header disclosure so the composer is collapsed by default inline; keep the `Sparkles` scan button and the rows exactly. **ARIA:** the disclosure is a `<button aria-expanded={composerOpen} aria-controls={composerId}>` whose accessible name is the visible "＋ Connect" label; the composer container carries `id={composerId}`, and on expand focus lands on its first form field — matching the per-element `aria-label` discipline already in this file (`:242,483,512,544,592,642`). The empty state becomes a single hairline line (no persistent form). `ConnectionsSurface.module.css` gains a `.footer`/rule treatment; the existing `.backlinks`/`.header`/`.list`/`.connectionMeta`/`.synapseMarker` rules are reused.
- Synapse rows: `MachineText` inline on the rationale (`:307-311`) is already introduced by #1 (P-1); it travels with the re-home unchanged.

### 7.3 Deep links + entry points swept

- `LibraryPaneBody.tsx`: delete `handleOpenLibraryIntelligence` (`:715-717`), the `selectedTab === "intelligence"` effect (`:718-722` — replaced: `?tab=intelligence` is consumed inside `LibraryBrief`), and the `requestSecondarySurface` destructure use (`:160`). `libraryResourceOptions` no longer receives `onViewIntelligence`.
- `LibrariesPaneBody.tsx`: the row action `openInNewPane(href, name, "library-intelligence")` (`:285-290`) becomes `openInNewPane(href, name)` — opening the library shows the brief inline; `presentLibrary`'s `onViewIntelligence` option is dropped.
- `lib/actions/resourceActions.ts`: delete the `onViewIntelligence` param + the `view-library-intelligence` option (`:139,148-154`); `lib/collections/presenters/library.ts` drops its `onViewIntelligence` (`:20`).
- `lib/panes/paneRouteModel.ts`: drop the five `secondaryGroups` bindings (§4.2). The `library`/`page`/`note`/`daily`/`dailyDate` routes keep their body/width contracts.

### 7.4 Budget / CSP / mobile

The brief and connections are already inside `React.lazy` pane bodies (not shell/LCP), so the ~104 kB first-load budget is unaffected (net: 857-line pane split into smaller lazily-loaded owners; connections component reused). No inline styles/scripts — nonce-CSP unaffected. Mobile loses two `SecondarySurfaceTabs` entries; the inline content scrolls in the pane body (`MobileSecondaryPaneHost` needs no change; the removed groups simply never publish).

---

## 8. Key decisions

- **D-1. The brief is present-but-quiet, above the entry list — never a card.** A collapsed machine-set lede with an expander, sharing the pane's left edge and measure. *Rejected:* (a) the full dossier always-expanded (dominates the list you came to see); (b) a bordered/rounded "insight card" with a gradient header (the exact AI-slop the owner loathes); (c) leaving it a drawer (the demotion this cutover deletes).
- **D-2. Empty library = silence + one plain button.** No artifact ⇒ no machine voice, no skeleton, no placeholder prose — only a single quiet, non-machine "Generate dossier" text button. *Rejected:* (a) a skeleton/placeholder that mimics a dossier (placeholder theater, forbidden); (b) auto-generating on open (silent automation of a user-owned decision — owner taste); (c) hiding generation entirely in the options menu (undiscoverable; the product thesis is *invite the co-author*, quietly).
- **D-3. Generation/staleness/coverage controls move inline; the SSE plane does not move.** `LibraryBriefControls` owns the generate form + status; it consumes the **unchanged** `useLibraryIntelligenceStream`. *Rejected:* re-implementing the stream inline (would fork the SSE decode; the hook is the seam).
- **D-4. Deep links survive, re-pointed at the inline brief.** `?tab=intelligence` auto-expands + scrolls; `?revision=` shows the revision inline. *Rejected:* dropping the params (breaks shared URLs and `paneIdentity` identity keys).
- **D-5. Page connections render as a foot-of-page apparatus (footer), not a margin.** The page body is a focus-managed ProseMirror editor with its own gutter; a right-margin rail would collide with it, steal horizontal measure, and be unusable on mobile. A foot-of-page apparatus is the scholarly convention for "what this text connects to." *Rejected:* a margin/side rail (gutter collision, width contention, mobile failure).
- **D-6. Dossier chat opens a real conversation pane.** With the drawer gone, the pane-swapping inline mini-chat is homeless; `startResourceChat(revisionRef)` + `openInNewPane` is the correct, already-built opener. *Rejected:* preserving an inline mini-chat inside the brief (a second chat UI owner, dashboard-itis).
- **D-7. `ConnectionsSurface` stays one component, re-homed with a quiet composer.** Reuse over rebuild; the composer collapses behind a disclosure so no permanent form sits under every page. *Rejected:* a parallel `PageConnections` renderer (duplicates the row/scan/dismiss logic that already has one owner).
- **D-8. No backend, no migration, no API.** Every field, endpoint, and event already exists; this is a pure presentation re-home. *Rejected:* a `brief_lede` column or a `/brief` projection (the lede is a render concern; adds a round trip and a migration for zero behavior).

---

## 9. What dies (exhaustive)

**Secondary model (`lib/panes/paneSecondaryModel.ts`):**
- `PANE_SECONDARY_GROUP_BASE["library-tools"]` (`:18-21`) and `["notes-tools"]` (`:22-25`).
- `PANE_SECONDARY_SURFACE_DEFINITIONS` `library-intelligence` (`:83-87`) and `notes-connections` (`:89-93`).

**Route model (`lib/panes/paneRouteModel.ts`):** the `secondaryGroups: ["library-tools"]` on `library` (`:107`) and `secondaryGroups: ["notes-tools"]` on `page` (`:207`), `note` (`:216`), `daily` (`:225`), `dailyDate` (`:234`).

**Library drawer:**
- `app/(authenticated)/libraries/[id]/LibraryIntelligencePane.tsx` — **file deleted** (its logic re-homed into the `LibraryBrief` family, §7.1).
- `LibraryPaneBody.tsx`: `usePaneSecondary(secondaryDescriptor)` + `secondaryDescriptor` (`:798-814`); `handleOpenLibraryIntelligence` + `?tab` effect (`:715-722`); `requestSecondarySurface` destructure (`:160`); the `onViewIntelligence` wiring (`:788`).
- `libraries/[id]/page.module.css`: the `.intelligence*` block (`:13-140` + narrow-width rules) — moved to `LibraryBrief.module.css`.
- `resourceActions.ts`: `onViewIntelligence` param + `view-library-intelligence` option (`:139,148-154`).
- `presenters/library.ts`: `onViewIntelligence` (`:20`).
- `LibrariesPaneBody.tsx`: the `"library-intelligence"` deep-link 3rd arg (`:289`) + the `onViewIntelligence` presenter option (`:285-291`).

**Notes drawer:**
- `PagePaneBody.tsx`: `secondaryDescriptor` + `usePaneSecondary` (`:703-721`); the "Show connections" pane option (`:677-683`).
- `NotePaneBody.tsx`: `secondaryDescriptor` + `usePaneSecondary` (`:177-195`); the "Show connections" pane option (`:163-174`).

**Dossier chat:** `LibraryIntelligencePane`'s `chatOpen` state + inline `ResourceChatDetail` swap (`:123,279-291`) — replaced by an `openInNewPane` opener (D-6). `ResourceChatDetail` itself survives.

No backend file, migration, or route is deleted (N2).

## 10. Sibling cutovers and sequencing

- **#1 `machine-hand-hard-cutover.md` — MUST land first (P-1).** It authors `MachineText` + tokens and *already* wraps the two exact sites this cutover relocates (dossier body `origin="Dossier"`; Synapse rationale `origin="Synapse"`). #10 moves those wrapped nodes into their inline homes. If #10 ships first, both render in warm Inter (temporary defect).
- **#8 `reader-sidecar-consolidation-hard-cutover.md` — shares `paneSecondaryModel.ts`, disjoint keys.** #8 removes five `reader-tools` surfaces (adding one new `reader-evidence`); #10 removes the `library-tools`/`notes-tools` groups + their two surfaces. No semantic conflict; whichever lands first, the other rebases its `satisfies` array edit. #8's §10 already records this. Neither touches the other's pane bodies (#8 = `MediaPaneBody`; #10 = `LibraryPaneBody`/`PagePaneBody`/`NotePaneBody`).
- **#2 `running-journal-hard-cutover.md` — shares `LibraryPaneBody.tsx`, disjoint regions.** #2 adds a human `SectionOpener` ("Libraries"/library name) + folio via `CollectionView`'s `opener` slot; #10 adds the machine `LibraryBrief` below it, above the rows. #2 N2 confirms `SectionOpener` renders no machine output — the brief is a `MachineText` block, not a `SectionOpener`. Coordinate the single body edit; order-independent.
- **#7 `daily-surface-consolidation-hard-cutover.md` / #4 `dawn-write-hard-cutover.md` — share `PagePaneBody.tsx`.** #7 routes daily pages through the Page pane (already true: `DailyNotePaneBody → PagePaneBody`), so #10's inline connections footer serves daily pages automatically. #4 renders a morning `MachineText` block **above** the daily note; #10's connections footer sits **below** the note — disjoint positions in the same body. Both compose `MachineText` (#1 before both). Coordinate the `PagePaneBody` edits.

## 11. Slices (each independently buildable + its verification)

- **S1 — Library brief inline (drawer still present).** Create `lib/library/dossierLede.ts` + `components/library/{LibraryBrief,LibraryBriefLede,LibraryBriefArtifact,LibraryBriefControls,LibraryBriefRevisions}.tsx` (+ `LibraryBrief.module.css` with the migrated `.intelligence*` rules) by extracting from `LibraryIntelligencePane.tsx`; mount `<LibraryBrief libraryId={id}/>` in `LibraryPaneBody` above `<PaneSurface>`. *Verify:* `deriveDossierLede` unit tests; browser tests — silence when `unavailable`; lede + expand; streaming `Generating…`; `?tab=intelligence` auto-expand; `?revision=` inline; Regenerate calls `generate`. Drawer still compiles (not yet removed).
- **S2 — Page connections inline (drawer still present).** Add the quiet-composer disclosure to `ConnectionsSurface`; render it in the `PagePaneBody`/`NotePaneBody` footers. *Verify:* browser tests — connections list renders inline; composer collapsed by default, reveals on "＋ Connect"; Synapse row keeps `✦`/dismiss/`MachineText` inline; scan button on scannable refs; `DailyNotePaneBody` shows the footer.
- **S3 — Hard cutover: delete both drawers + sweep.** Remove the two groups + two surfaces from `paneSecondaryModel.ts`; drop the five `secondaryGroups` from `paneRouteModel.ts`; delete `LibraryIntelligencePane.tsx`; delete both `usePaneSecondary`/"Show connections"/"Intelligence" call sites; re-point `LibrariesPaneBody`/`resourceActions`/`presenters/library`; wire the dossier-chat `openInNewPane` opener; delete `.intelligence*` from `page.module.css`. Fix every compile error the union narrowing surfaces. *Verify:* `bun run typecheck && bun run lint` clean; the negative gates (§13); model/route tests updated (§14); workspace-restore degradation test.
- **S4 — Test sweep + polish + gates.** Update all tests in §14; add the empty-state/silence and deep-link tests; screenshot baselines for the brief + connections footer. *Verify:* `bun run test:unit && bun run test:browser`; `bun run build` (bundle budget); e2e/csp deferred (house pattern, noted).

## 12. Acceptance criteria (testable)

- **AC-1.** `PANE_SECONDARY_GROUP_BASE` has exactly `reader-tools` + `conversation-context`; `PANE_SECONDARY_SURFACE_DEFINITIONS` contains no `library-intelligence` or `notes-connections`.
- **AC-2.** Opening a library with a `current`/`stale` dossier renders the brief inline above the entry list: a `MachineText` lede signed `DOSSIER`, an expander to the full body + citations. The expander button starts `aria-expanded="false"` and flips to `true` on activation, revealing the region it `aria-controls`. No secondary tab is offered for the library.
- **AC-3.** A library with no dossier (`unavailable`, no content) renders no machine-voiced content and no skeleton — only the entry list plus one quiet non-machine "Generate dossier" button.
- **AC-4.** Regenerate/Generate streams over the unchanged SSE plane; the brief shows `Generating…` progress in place and settles to the new revision. `GENERATION_RUN_STREAM_PATHS["library-intelligence"] === "/stream/library-intelligence"` still holds.
- **AC-5.** `/libraries/{id}?tab=intelligence` opens the library with the brief expanded and scrolled to; `?tab=intelligence&revision={id}` renders that revision inline.
- **AC-6.** A page/note renders a foot-of-page Connections apparatus below the editor; a Synapse-origin row shows the `✦` marker, its rationale in `MachineText` inline, and a dismiss (`×`) that calls the suppression endpoint. No `notes-connections` secondary tab exists.
- **AC-7.** The connections composer (Connect/Attach) is collapsed by default inline and reveals on the header disclosure: the "＋ Connect" button toggles `aria-expanded` false→true and focus moves to the first composer field on expand. An empty page shows at most a hairline label, not a persistent form.
- **AC-8.** No `usePaneSecondary` call and no `requestSecondarySurface("library-intelligence" | "notes-connections")` remains in `LibraryPaneBody`/`PagePaneBody`/`NotePaneBody`; `LibraryIntelligencePane.tsx` does not exist.
- **AC-9.** Restoring a stored workspace with `activeSurfaceId: "library-intelligence"` or `"notes-connections"` drops that secondary pane and opens the primary cleanly (no crash).
- **AC-10.** The `reader-tools` group and its surfaces are untouched by this cutover's diff (sibling #8 owns them).
- **AC-11.** Static gates green: `bun run typecheck`, `bun run lint`, `bun run build` (bundle budget), unit + browser suites, and the negative gates.

## 13. Negative gates (grep-able assertions)

Implemented in `lib/panes/paneSecondaryModel.test.ts` (source-grep, house FE gate form) + the touched tests:

1. **Surfaces gone.** `PANE_SECONDARY_SURFACE_DEFINITIONS.map(d => d.id)` contains neither `"library-intelligence"` nor `"notes-connections"`; `PANE_SECONDARY_GROUP_BASE` has no `"library-tools"`/`"notes-tools"` key.
2. **Route bindings gone.** No `secondaryGroups: ["library-tools"]` or `["notes-tools"]` in `paneRouteModel.ts`.
3. **No drawer publication.** No `usePaneSecondary(` in `LibraryPaneBody.tsx`, `PagePaneBody.tsx`, `NotePaneBody.tsx`.
4. **No drawer open call.** No `requestSecondarySurface(` with `"library-intelligence"`/`"notes-connections"` anywhere in `src`; no `openInNewPane(.., .., "library-intelligence")` 3rd-arg call.
5. **Pane deleted.** No file `libraries/[id]/LibraryIntelligencePane.tsx`; no import of `./LibraryIntelligencePane`; no `LibraryIntelligencePane` identifier in `src`.
6. **Menu option gone.** No `view-library-intelligence` id and no `onViewIntelligence` in `resourceActions.ts` / `presenters/library.ts`.
7. **CSS moved.** No `.intelligence` selector in `libraries/[id]/page.module.css`.
8. **SSE unchanged (anti-regression).** `GENERATION_RUN_STREAM_PATHS["library-intelligence"] === "/stream/library-intelligence"` and `useLibraryIntelligenceStream` still imports `useGenerationRun` — asserted, not deleted.
9. **Machine voice, not raw.** The dossier body and the Synapse rationale render inside a `MachineText` ancestor (composition of #1's gate, not re-authored here).

## 14. Test plan

- **Unit (`.test.ts`, node):** `dossierLede.test.ts` (first paragraph, mark-strip, word-boundary truncation, empty→""); `paneSecondaryModel.test.ts` rewritten — `getSecondarySurfaceIdsForGroup` no longer returns `library-tools`/`notes-tools`; `isWorkspaceSecondarySurfaceId("library-intelligence") === false`; group set assertions (§13.1). `paneRouteTable.test.tsx` (`:46,64,77,87`) drop the `notes-tools` `toContain` assertions; `paneIdentity.test.ts` (`:59`) keeps `?tab=intelligence` as a valid identity href. `workspaceRestore.test.ts` (`:55-56`) re-point its default fixture off the removed ids and add a degradation case (stored `library-intelligence` → dropped).
- **Browser (`.test.tsx`, Chromium — real providers, fetch-boundary mock):**
  - `LibraryBrief.test.tsx` (new; ports the surviving cases from `__tests__/components/LibraryIntelligencePane.test.tsx`): silence when unavailable; lede + expand (assert the expander is `aria-expanded=false` → `true` and reveals its `aria-controls` region, AC-2); streaming keeps content visible + subscribes the draft revision (`:579-584` stream-path assertion preserved) **and renders `role=status` during build / `role=alert` on failure** (live-region preservation, §7.1); stale count + Regenerate; citation activation (reader pulse / note pulse); revision open/restore (`:665` deep link); coverage/omission metadata; **the "Chat about this dossier" rejection path surfaces a `FeedbackNotice`, not a thrown error** (D-6). Delete `LibraryIntelligencePane.test.tsx`.
  - `ConnectionsSurface.test.tsx`: composer collapsed-by-default + reveal (assert the "＋ Connect" disclosure toggles `aria-expanded` false→true and focus lands on the first composer field, AC-7); Synapse row `MachineText`/dismiss intact; user-origin delete intact; scan button on scannable refs.
  - `LibraryPaneBody` / `PagePaneBody` / `NotePaneBody` tests: assert the inline brief / connections footer render and that no secondary publication is emitted; drop the removed pane-option assertions.
  - Workspace: `panePublications.test.ts`, `paneRuntime.test.tsx`, `DailyNotePaneBody.test.tsx` — rebuild fixtures off the two removed groups; `resourceActions.test.ts` (`:182-237`) drop the `view-library-intelligence` cases. (`SecondarySurfaceTabs.test.tsx`/`WorkspaceHost.test.tsx` need no change — verified to reference only `reader-tools`/`conversation-context` fixtures, never the removed ids.)
- **Not run (house pattern, noted):** e2e / CSP — no route or header change; heavy suites deferred. **One e2e will break when run:** `e2e/tests/notes.spec.ts:~421-426` clicks the deleted "Show connections" menu item and asserts the deleted `workspace-secondary-pane` (`aria-label="Connections"`) DOM contract. When e2e is run, update it to assert `ConnectionsSurface` renders inline in the pane-body footer. Also re-point the hand-coded unions in `e2e/tests/workspace.ts` (drop `"library-tools"`/`"notes-tools"` from `groupId` and `"library-intelligence"`/`"notes-connections"` from `activeSurfaceId`).
- **Ladder:** `bun run typecheck && bun run lint`; focused `LibraryBrief`/`ConnectionsSurface`/`paneSecondaryModel`/`workspaceRestore` + touched pane-body tests; then `bun run test:unit && bun run test:browser`; `bun run build`.

## 15. Files (touched / created / deleted)

**Created (FE):** `components/library/{LibraryBrief,LibraryBriefLede,LibraryBriefArtifact,LibraryBriefControls,LibraryBriefRevisions}.tsx` + `LibraryBrief.module.css` + `LibraryBrief.test.tsx`; `lib/library/dossierLede.ts` + `dossierLede.test.ts`; this spec.

**Modified (FE):** `lib/panes/paneSecondaryModel.ts` (drop 2 groups + 2 surfaces) + `.test.ts`; `lib/panes/paneRouteModel.ts` (drop 5 `secondaryGroups`) + `paneRouteTable.test.tsx`; `app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx` (mount brief, delete drawer) + `page.module.css` (drop `.intelligence*`); `libraries/LibrariesPaneBody.tsx`; `lib/actions/resourceActions.ts` + `.test.ts`; `lib/collections/presenters/library.ts`; `components/connections/ConnectionsSurface.tsx` (+ `.module.css`, `.test.tsx`); `app/(authenticated)/pages/[pageId]/PagePaneBody.tsx`; `app/(authenticated)/notes/[blockId]/NotePaneBody.tsx`; `app/(authenticated)/daily/DailyNotePaneBody.test.tsx`; `lib/workspace/workspaceRestore.test.ts`; `lib/panes/{paneIdentity.test.ts,panePublications.test.ts,paneRuntime.test.tsx}`; `e2e/tests/workspace.ts` (drop the removed ids from the hand-coded secondary-pane unions) and `e2e/tests/notes.spec.ts` (re-point the deleted "Show connections" secondary-pane assertion when e2e is run); screenshot baselines for the brief + connections footer.

**Deleted (FE):** `app/(authenticated)/libraries/[id]/LibraryIntelligencePane.tsx`; `src/__tests__/components/LibraryIntelligencePane.test.tsx` (+ its `__screenshots__`).

**Unchanged (load-bearing):** `components/library/useLibraryIntelligenceStream.ts`; `lib/api/useGenerationRun.ts`; `lib/api/sse/libraryIntelligenceEvents.ts`; all backend.

**Memory (on merge):** record the machine-output-in-place re-home (drawers deleted; `LibraryBrief` owns the inline dossier; connections are a page footer; SSE plane untouched; sweep gates).

## 16. Risks

- **R1. #1 not landed → machine artifacts in warm Inter.** *Control:* P-1 + gate §13.9; the slate fixes #1 before #10. If forced early, it is a known temporary defect, not a design choice.
- **R2. Shared-file churn** on `LibraryPaneBody` (#2), `paneSecondaryModel.ts` (#8), `PagePaneBody` (#4/#7). *Control:* §10 enumerates disjoint regions/keys; land the union edit atomically in S3; stage explicitly (concurrent-agent checkout — repo memory), never `git add -A`.
- **R3. Streaming regression during the pane split.** *Control:* `useLibraryIntelligenceStream`/`useGenerationRun` are moved *as-is* into `LibraryBrief`; the stream-path assertion (`LibraryIntelligencePane.test.tsx:579-584`) is ported to `LibraryBrief.test.tsx`; gate §13.8 anti-regresses the path.
- **R4. The brief crowds the entry list.** *Control:* D-1 — collapsed lede by default, one expander, no card; screenshot review is the gate; the entry list stays the pane's subject.
- **R5. A permanent composer under every page.** *Control:* D-7 quiet-composer disclosure + AC-7; empty page = hairline label at most.
- **R6. Stale workspace state referencing removed ids.** *Control:* P-4 (`sanitizeAttachedSecondaryPane` guard drop) + the AC-9 degradation test.
