# The Dawn Write — Hard Cutover

**Status:** Spec · **Rev 1** · 2026-07-07
**Type:** Hard cutover — no legacy code, no fallbacks, no compat shims, no flags-for-old-behavior.

## One-line

Once a day, at the first hourly job tick after midnight in the user's local timezone, a background job generates two short machine paragraphs — grounded in yesterday's highlights, overnight Synapse resonances, and stale library dossiers — and stores them as a current-only artifact that renders **above** the editable daily note in the machine's own typographic voice, one-tap dismissible with permanent memory.

---

## 0. Prerequisites (hard, no fallback)

- **P-1.** `machine-hand-hard-cutover.md` (sibling #1) has landed. `MachineText` (`components/ui/MachineText.tsx`), `--font-machine`/`--ink-machine`/`--rail-machine` tokens, and the `MarkdownMessage` prose inheritance already exist. Dawn write renders through `MachineText` block; sibling #1 must be merged first.
- **P-2.** `resource_edges.origin` already includes `'synapse'` (migration 0149, `ck_resource_edges_origin`, `db/models.py:579–587`). Synapse edges with `snapshot.excerpt` rationales are live data the dawn write reads.
- **P-3.** The `highlights` table (`db/models.py:3417`) has `user_id`, `created_at`, `anchor_media_id`, and `exact` text — all available for the yesterday-reading query.
- **P-4.** `library_intelligence_artifacts` + `library_intelligence_artifact_revisions` and the `_compute_freshness` function (`services/library_intelligence.py:214`) are live. Stale-artifact detection requires no new infrastructure. A thin public accessor `is_artifact_stale` (added by this cutover in S1) wraps it for cross-module use.
- **P-5.** `daily_note_pages` (`db/models.py:254`) records `time_zone` per user per date — the honest timezone source for the job (§4.3).
- **P-6.** `run_llm_task` / `LlmTaskSpec` (`tasks/llm_task.py:33`) and `LedgeredLLM` (`services/llm_ledger.py`) are the sole LLM envelope. The dawn write generates one prose response through `LedgeredLLM.generate()` directly (not `run_structured_synthesis` — prose, not JSON).
- **P-7.** Anthropic haiku `claude-haiku-4-5-20251001` is already pinned and verified in `MODEL_CATALOG` (see `services/synapse.py:91–92`). No new catalog entry required.
- **P-8.** `DailyNotePaneBody.tsx` (`app/(authenticated)/daily/DailyNotePaneBody.tsx:32`) is the current host for today's daily page. It delegates to `PagePaneBody`. Dawn write renders above `PagePaneBody` as a sibling in this component's return fragment. **When sibling #7 (`daily-surface-consolidation-hard-cutover.md`) kills `DailyNotePaneBody` and reroutes daily pages through the Notes/Page pane, that spec must carry the `DawnWriteBlock` render into its new host.** The `DawnWriteBlock` component (#4) and the API contract (#4) are stable.

---

## 1. Problem (grounded diagnosis)

Every morning the daily note opens blank. The blank is good — the page belongs to the user. But the system has already seen things the user may have forgotten: highlights made yesterday, connections the Synapse engine surfaced overnight, library dossiers that fell out of date. None of this speaks unless the user explicitly asks.

The absence today:
- `DailyNotePaneBody.tsx:32` renders `<PagePaneBody pageIdOverride={page.id} initialPage={page} />` — one component, nothing above it.
- `DailyNotePage` rows (`daily_note_pages`) carry the timezone the user's browser reported (stored at first-access as `time_zone`, default `"UTC"`) but no process reads them to generate ambient awareness.
- `displayTimeZone` in `lib/renderEnvironment/server.ts:20` is hardcoded to `"UTC"` — the server-side render environment has no user timezone. The only honest per-user timezone record is `daily_note_pages.time_zone`.
- Synapse edges with `origin='synapse'` and their one-line rationale in `snapshot.excerpt` are written to `resource_edges` overnight but only surface in the Connections section of the object that was scanned — the user must navigate there to see them.
- `library_intelligence_artifacts.current_revision_id` combined with the fingerprint comparison in `_compute_freshness` (`services/library_intelligence.py:214`) can tell us a dossier is stale, but nothing announces it.

The result: the machine worked overnight and said nothing. The daily note page is the natural moment to speak — once, briefly, above the fold, then silent.

---

## 2. Target behavior (user-facing)

- Opening today's daily note when a dawn write exists shows a machine-typeset block **above** the ProseMirror editor. The block is set in the machine face (`--font-machine`, `--ink-machine`) with a `DAWN · <hh:mm>` signature (the generation time) and a hairline left rail — the Machine Hand register owned by sibling #1.
- The block contains two short paragraphs (≤200 words total). Each paragraph is grounded: it names specific sources, specific highlights, specific rationale lines. It does not editorialize or recommend.
- A single dismiss button sits outside the `MachineText` wrapper (per the control-bleed rule, `machine-hand-hard-cutover.md §4.4`). One tap dismisses permanently — no confirm dialog, no "are you sure." The block vanishes immediately (optimistic) and is never shown again that day.
- The dismissal is remembered in the server row (`dismissed_at`). No regeneration same day. No re-nag. No badge. No count. No notification. No unread state. The block either exists or it does not.
- If the job has not yet run (e.g. the user opens the daily note at 00:05), or if generation failed, there is simply no block — the note appears blank as usual. No error state, no skeleton, no "loading…" placeholder.
- The page below is still yours and still blank: the `ProseMirrorOutlineEditor` is unchanged.

---

## 3. Goals / Non-goals

### Goals

- **G1.** One current-only artifact per user per local date: `dawn_writes(user_id, local_date)` with unique constraint; one row or none.
- **G2.** Grounded content: yesterday's highlights (actual `exact` text + media title), overnight Synapse rationales (actual `snapshot.excerpt`), stale dossier names. The model receives the raw materials; it reports, does not invent.
- **G3.** Machine typography: `MachineText` block, `origin={{ label: "Dawn" }}`, `timestamp` from `generated_at`. Provenance is visible and honest.
- **G4.** Permanent one-tap dismissal with server memory (`dismissed_at`). No regeneration, no re-nag.
- **G5.** Standard job infrastructure: `dawn_write_job` in `registry.py`, `USER_FACING_JOB_KINDS`, `DEFAULT_WORKER_ALLOWED_JOB_KINDS`, `config.py`, `env-prod-worker.example`, and `sync-env.sh` SAFE allowlist — all updated atomically in the same PR. Missing any one of these is the known deploy incident class.
- **G6.** `DAWN_WRITE_ENABLED=false` config flag (mirroring `SYNAPSE_ENABLED`) turns the job into a no-op without code changes.
- **G7.** LLM call ledgered as `owner_kind='dawn_write'` with `owner_id = dawn_write.id`.

### Non-goals

- **N1.** No resource graph edges from the dawn write to its sources. D-4 below records the decision and its honest cost.
- **N2.** No stream. Dawn write is a background batch; the user fetches the artifact on page open.
- **N3.** No manual regeneration. One write per day; the dismiss button is the only interaction.
- **N4.** No cross-user or shared dawn writes. Per-user only.
- **N5.** No multi-paragraph structure parsing or section headers. Two paragraphs, plain markdown prose.
- **N6.** No push notification or badge when the write becomes available.
- **N7.** No archive of past day writes. `dawn_writes` is current-only — one live row per user per day; prior days are not queryable through the product.

---

## 4. Architecture and final state

### 4.1 Final ownership map

| Concern | Sole owner | Notes |
|---|---|---|
| Artifact storage | `dawn_writes` table (migration 0169) | One row per `(user_id, local_date)` |
| Job scheduling | `dawn_write_job` in `jobs/registry.py` | Periodic via `DAWN_WRITE_SCHEDULE_SECONDS` |
| Generation logic | `services/dawn_write.py` | Data assembly + LLM call |
| Worker task body | `tasks/dawn_write.py` | `run_llm_task` envelope |
| API (read + dismiss) | `api/routes/notes.py` + BFF routes | See §6 |
| Frontend component | `components/notes/DawnWriteBlock.tsx` | `MachineText` block + dismiss button |
| Frontend render site | `DailyNotePaneBody.tsx` (today); sibling #7's host (future) | Sibling #7 must carry this |

### 4.2 Job scheduling model

`dawn_write_job` is a **sweep periodic job**: it runs on a configurable interval (default `3600` seconds — hourly) and its single handler iterates all users. For each user it:
1. Reads the most recently stored `daily_note_pages.time_zone` for that user (the honest timezone source — see §4.3).
2. Computes the user's current local date using that timezone.
3. Checks whether a `dawn_writes` row for `(user_id, current_local_date)` already exists. If so, skips (idempotent).
4. If none exists: assembles content signals (§4.4), calls the model, writes the row.

The periodic scheduler's dedupe key is `periodic:dawn_write_job:{slot_start}` — one enqueue per slot, covering all users in one handler run. This is appropriate for a single-user prototype; fan-out-per-user would be over-engineered.

Failure of any single-user generation is logged and skipped; the sweep continues to the next user. No job-level failure is raised (the job succeeded its sweep even if one user's generation fails). Failure = absent block, never a UI error.

### 4.3 Timezone source — the honest reckoning

`lib/renderEnvironment/server.ts:20` hardcodes `displayTimeZone = "UTC"`. The server has no other per-user timezone source. The only honest record is `daily_note_pages.time_zone`, stored when the browser first opens a daily note page (the client sends its `Intl.DateTimeFormat().resolvedOptions().timeZone` via the `?time_zone=` query parameter to `GET /notes/daily`, `api/routes/notes.py:79`).

**Consequence:** a new user who has never opened `/daily` has no timezone record. The job skips them until their first daily note visit creates a `daily_note_pages` row. This is correct: if the user has never opened a daily note, there is nowhere to display the dawn write.

**Query:** `SELECT time_zone FROM daily_note_pages WHERE user_id = :uid ORDER BY created_at DESC LIMIT 1`.

### 4.4 Content signals (the data the model receives)

Three sources, all queries scoped to `user_id`, all in a single sync DB session before the async LLM call:

**Signal A — Yesterday's highlights:**
```sql
SELECT h.exact, m.title AS media_title, h.created_at
FROM highlights h
JOIN media m ON m.id = h.anchor_media_id
WHERE h.user_id = :uid
  AND h.created_at >= :yesterday_start_utc   -- midnight yesterday in user's tz
  AND h.created_at <  :today_start_utc       -- midnight today in user's tz
ORDER BY h.created_at
LIMIT 10
```
Rows where `anchor_media_id IS NULL` (highlights without a media anchor) are excluded — they have no readable title.

**Signal B — Overnight Synapse resonances (last 24 h):**
```sql
SELECT re.snapshot, re.source_scheme, re.source_id,
       re.target_scheme, re.target_id, re.created_at
FROM resource_edges re
WHERE re.user_id = :uid
  AND re.origin = 'synapse'
  AND re.created_at >= :yesterday_start_utc
ORDER BY re.created_at DESC
LIMIT 5
```
`snapshot->>'excerpt'` is the rationale (one sentence, stored by `synapse.py:329`).

**Signal C — Stale library dossiers:**
```sql
SELECT lib.name, art.id AS artifact_id, rev.id AS revision_id
FROM library_intelligence_artifacts art
JOIN libraries lib ON lib.id = art.library_id
JOIN library_intelligence_artifact_revisions rev
  ON rev.id = art.current_revision_id
WHERE art.user_id = :uid
  AND rev.status = 'ready'  -- only completed (head) revisions carry meaningful freshness
  AND rev.promoted_at IS NOT NULL
```
Then call `is_artifact_stale(db, library_id=..., current_revision_id=...)` (public accessor in `services/library_intelligence.py` added by this cutover — see §15) on each result; collect those that return `True`.

`is_artifact_stale` is a thin public wrapper around the private `_compute_freshness` at line 214. Cross-module callers must use the public accessor, not `_compute_freshness` directly.

**Skip rule:** if all three signals are empty, skip generation and write no row. The block does not appear if the machine has nothing honest to say.

### 4.5 Prompt structure

Single non-streaming `LedgeredLLM.generate()` call. System prompt:

```
You are the dawn writer for a reading system. You have access to one user's
reading activity from yesterday. Write exactly two short paragraphs — no
headers, no lists, no markdown except paragraph breaks. Total ≤200 words.

Paragraph 1: what the reader engaged with yesterday — highlights made, their
text, the source titles. Be specific and concrete; quote brief phrases.

Paragraph 2: what the system noticed overnight — Synapse resonances (new
connections with rationales), stale library dossiers that need refresh.
If either category is empty, fold it into a single paragraph.

Rules:
1. Only state what the data contains. Do not invent, extrapolate, or recommend.
2. No "You highlighted…" preamble. Begin mid-sentence, as apparatus, not address.
3. No score, no rating, no count of items. Name things, not numbers.
```

User turn: the assembled signals rendered as plain text (highlight excerpts with source title and date, synapse rationales with source/target labels, stale library names).

Model: `anthropic` / `claude-haiku-4-5-20251001`. `max_tokens=300`, `timeout_s=45`. BYOK-first via `resolve_api_key(db, user_id, "anthropic", "auto")`. If no API key is available, skip generation for this user (log `dawn_write_skipped`, reason `no_api_key`).

---

## 5. Data model / migration

### 5.1 New table: `dawn_writes`

```sql
CREATE TABLE dawn_writes (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid        NOT NULL REFERENCES users(id),
    local_date   date        NOT NULL,
    body_md      text        NOT NULL,
    generated_at timestamptz NOT NULL DEFAULT now(),
    dismissed_at timestamptz,
    CONSTRAINT uq_dawn_writes_user_date UNIQUE (user_id, local_date),
    CONSTRAINT ck_dawn_writes_body_nonempty CHECK (char_length(body_md) >= 1)
);

CREATE INDEX ix_dawn_writes_user ON dawn_writes (user_id);
```

No `ON DELETE CASCADE` (house doctrine; explicit cleanup if user is deleted). `dismissed_at` NULL means not yet dismissed; set once, never unset. No `ON CONFLICT` upserts (house doctrine); the generation sweep checks for existence before writing.

### 5.2 Migration: `0169_dawn_write_artifact.py`

`down_revision = "0168"`.

**upgrade:**
1. Create `dawn_writes` table with constraints and index above.
2. Widen `ck_llm_calls_owner_kind` (drop + re-add) to include `'dawn_write'`.

Current value (models.py:4011):
```sql
owner_kind IN ('chat_run', 'oracle_reading', 'li_revision',
               'media_summary', 'media_enrichment', 'synapse_scan')
```
New value adds `'dawn_write'`.

**downgrade:**
1. `DELETE FROM llm_calls WHERE owner_kind = 'dawn_write'`.
2. Restore narrowed `ck_llm_calls_owner_kind`.
3. `DROP TABLE dawn_writes`.

### 5.3 ORM model addition: `DawnWrite`

Add to `db/models.py` (after `DailyNotePage`):

```python
class DawnWrite(Base):
    """Current-only machine-generated morning block for one user + local date."""

    __tablename__ = "dawn_writes"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.id"), nullable=False
    )
    local_date: Mapped[date] = mapped_column(Date, nullable=False)
    body_md: Mapped[str] = mapped_column(Text, nullable=False)
    generated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=text("now()"), nullable=False
    )
    dismissed_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)

    __table_args__ = (
        UniqueConstraint("user_id", "local_date", name="uq_dawn_writes_user_date"),
        CheckConstraint("char_length(body_md) >= 1", name="ck_dawn_writes_body_nonempty"),
        Index("ix_dawn_writes_user", "user_id"),
    )
```

---

## 6. API

### 6.1 FastAPI routes (in `api/routes/notes.py`)

**Read today's dawn write:**
```
GET /notes/dawn-write?local_date=2026-07-07
```
Response (200): always `{ "write": { "id": "<uuid>", "body_md": "...", "generated_at": "...", "dismissed_at": null | "..." } }` when a row exists, or `{ "write": null }` when none exists. The envelope is uniform — the `write` key is always present.
Auth: `get_viewer` (standard JWT). Only returns rows for `viewer.user_id`.

Implementation: `db.scalar(select(DawnWrite).where(DawnWrite.user_id == viewer.user_id, DawnWrite.local_date == local_date))`. Returns `{"write": schema}` or `{"write": null}`.

**Dismiss:**
```
POST /notes/dawn-write/{write_id}/dismiss
```
Response: 204. Sets `dismissed_at = now()` WHERE `id = write_id AND user_id = viewer.user_id AND dismissed_at IS NULL`. If already dismissed or not found: 204 (idempotent). No rowcount-driven control flow (house doctrine) — the absence of a row is not an error.

### 6.2 BFF routes (Next.js)

- `apps/web/src/app/api/notes/dawn-write/route.ts` — `GET` → `proxyToFastAPI(req, "/notes/dawn-write")`
- `apps/web/src/app/api/notes/dawn-write/[writeId]/dismiss/route.ts` — `POST` → `proxyToFastAPI(req, "/notes/dawn-write/${writeId}/dismiss")`

Both: `runtime = "nodejs"`, `dynamic = "force-dynamic"`, `revalidate = 0`.

### 6.3 Frontend API functions (in `lib/notes/api.ts`)

```typescript
export interface DawnWrite {
  id: string;
  body_md: string;
  generated_at: string;
  dismissed_at: string | null;
}

// GET /api/notes/dawn-write → { write: DawnWrite | null } always; unwrap body.write
export async function fetchDawnWrite(localDate: string): Promise<DawnWrite | null>;
export async function dismissDawnWrite(writeId: string): Promise<void>;
```

---

## 7. Frontend

### 7.1 `DawnWriteBlock` component

**File:** `apps/web/src/components/notes/DawnWriteBlock.tsx` + `DawnWriteBlock.module.css`

```tsx
// components/notes/DawnWriteBlock.tsx
"use client";

import { useState } from "react";
import MachineText from "@/components/ui/MachineText";
import MarkdownMessage from "@/components/ui/MarkdownMessage";
import { dismissDawnWrite, type DawnWrite } from "@/lib/notes/api";
import styles from "./DawnWriteBlock.module.css";

interface DawnWriteBlockProps {
  write: DawnWrite;
}

export default function DawnWriteBlock({ write }: DawnWriteBlockProps) {
  const [dismissed, setDismissed] = useState(write.dismissed_at !== null);

  if (dismissed) return null;

  const handleDismiss = () => {
    setDismissed(true);          // optimistic
    void dismissDawnWrite(write.id).catch(() => {
      // Server failure on dismiss is silent — the block will reappear on next
      // page load (dismissed_at remains null) which is preferable to showing
      // an error state for a dismiss action.
    });
  };

  const displayTime = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(write.generated_at));

  return (
    <div className={styles.dawnWriteShell} data-testid="dawn-write-block">
      <MachineText
        origin={{ label: "Dawn" }}
        timestamp={displayTime}
        variant="block"
      >
        <MarkdownMessage content={write.body_md} />
      </MachineText>
      <button
        className={styles.dismissButton}
        onClick={handleDismiss}
        aria-label="Dismiss dawn write"
        type="button"
      >
        Dismiss
      </button>
    </div>
  );
}
```

The dismiss button sits **outside** the `MachineText` wrapper (the control-bleed rule: `machine-hand-hard-cutover.md §4.4`). `MarkdownMessage` inside `MachineText` inherits `--font-machine` (per the machine-hand cutover's `MarkdownMessage.module.css` flip to `color: inherit`).

`DawnWriteBlock.module.css`: `.dawnWriteShell` is `display: flex; flex-direction: column; gap: var(--space-2)`. `.dismissButton` is small, quiet type — same treatment as the `synapse-suppressions` dismiss in `ConnectionsSurface.tsx` (plain text button, `color: var(--ink-muted)`).

### 7.2 Integration into `DailyNotePaneBody.tsx`

The dawn write fetch must be placed **before all conditional early returns** so it runs regardless of which page-resolution path is active. The existing component has two page-render paths: (a) `if (shellPageId) return <PagePaneBody pageIdOverride={shellPageId} />` (workspace-restore fast path, the common return-visit state) and (b) the final return after `dailyResource` resolves. Without hoisting, the fetch only fires on path (b) and the block is invisible on the majority of return visits.

```tsx
// Inside DailyNotePaneBody — BEFORE the early returns, alongside existing hooks:
const dawnWriteResource = useResource({
  cacheKey: validLocalDate ? `dawn-write:${localDate}` : null,
  load: () => fetchDawnWrite(localDate),
});

const dawnWrite =
  dawnWriteResource.status === "ready" ? dawnWriteResource.data : null;

// ... existing error/loading guards (unchanged) ...

// Shell-restore fast path — render dawn write above the page:
if (shellPageId) {
  return (
    <>
      {dawnWrite && <DawnWriteBlock write={dawnWrite} />}
      <PagePaneBody pageIdOverride={shellPageId} />
    </>
  );
}

// ... existing dailyResource error/loading guards ...

// Daily-fetch path — render dawn write above the page:
return (
  <>
    {dawnWrite && <DawnWriteBlock write={dawnWrite} />}
    <PagePaneBody pageIdOverride={page.id} initialPage={page} />
  </>
);
```

The dawn write fetch is non-blocking: if it errors, `dawnWrite` remains `null` and the block is absent. The daily note page itself is never blocked by the dawn write. The `cacheKey` depends on `validLocalDate` (not `page`) so the fetch fires on both resolution paths once the date is known.

### 7.3 Sibling #7 sequencing note (forward-ref)

When `daily-surface-consolidation-hard-cutover.md` (sibling #7) eliminates `DailyNotePaneBody` and routes daily pages through the Notes/Page pane directly, it **must** carry the `DawnWriteBlock` render into the new host. The `DawnWriteBlock` component, its CSS, the API functions, and the BFF routes are all stable and owned by this spec. Sibling #7 re-homes the render site, not the component.

### 7.4 Budget / CSP

`DawnWriteBlock` is a small functional component in an already-loaded pane body (not shell/LCP). The `MachineText` and `MarkdownMessage` components are already present. No new font load, no inline styles, no `next/image`. CSP unaffected.

---

## 8. Key decisions

- **D-1. Sweep periodic job, not per-user enqueued jobs.** *Rejected:* fan-out to one `dawn_write_job:<user_id>:<date>` per user. For a single-user prototype, a sweep is simpler and eliminates a fan-out layer. A single job per slot runs once and covers all users in one handler body. No per-user dedupe key needed; the DB's `UNIQUE (user_id, local_date)` is the idempotency gate.

- **D-2. Timezone source = `daily_note_pages.time_zone`; UTC fallback for new users.** *Rejected:* (a) ship a per-user timezone preference table — adds a settings surface and migration for a field the system already records at daily-note access time; (b) use UTC for everyone — generates the write at UTC midnight, wrong for most timezones. `daily_note_pages.time_zone` is the only honest record of what timezone the user's browser reported. Users with no `daily_note_pages` rows (never opened `/daily`) are simply skipped — there is nowhere to display the write.

- **D-3. Skip generation when all signals are empty.** *Rejected:* generate a boilerplate "quiet day" message. The owner hates AI slop. A machine that says nothing is better than one that makes something up or writes filler. Empty signals = no row = no block.

- **D-4. Snapshot-only provenance; no `resource_edges` from the dawn write.** *Rejected:* add `'dawn_write'` as a new `source_scheme` to `resource_edges` and create edges from the artifact to its cited highlights/synapse-edges/libraries. The honest cost of rejection: no machine-readable citation graph from this artifact to its sources; `llm_calls` is the only provenance link. This is accepted because (a) the artifact is dismissed daily — durable edges from a transient artifact have no useful lifetime; (b) adding `dawn_write` to the `source_scheme` CHECK would widen nine constraints in `db/models.py` plus all their migration counterparts; (c) the `body_md` text names sources explicitly, so the human can follow the provenance. The "citations-or-it-didn't-happen" doctrine applies to durable research artifacts; a morning brief is not that.

- **D-5. `DAWN_WRITE_ENABLED` config flag (default `true`).** *Rejected:* always-on with no kill switch. Mirroring `SYNAPSE_ENABLED`, the flag costs one field and one no-op guard; it lets an operator disable generation without a deploy.

- **D-6. Dismiss is optimistic and silent on server failure.** *Rejected:* show a dismiss error toast. A failed dismiss means the block reappears on next page load — an acceptable minor inconsistency compared to surfacing an error state for a throw-away action. The dismiss action must never block reading or editing.

- **D-7. Render above `PagePaneBody` in `DailyNotePaneBody`, not inside it.** *Rejected:* pass a `dawnWrite` prop into `PagePaneBody` and render it inside `editorShell`. The dawn write is not part of the page or note model — it is a separate artifact. `PagePaneBody` has one owner (the page+blocks); mixing a separate artifact into its render creates coupling. The sibling layout (`DawnWriteBlock` + `PagePaneBody` as siblings in the fragment return) is clean and composable.

- **D-8. Light-tier model, 300-token cap, 45s timeout.** *Rejected:* reasoning-tier model. The task is summarization + quotation selection, not reasoning. The haiku model at `≤300` output tokens costs a fraction of a reasoning call and has no latency advantage to offer the user (the write is background-generated). Matching the synapse envelope keeps the ops surface uniform.

- **D-9. `dawn_write_job` is NOT in `USER_FACING_JOB_KINDS`.** *Rejected:* add it there. `USER_FACING_JOB_KINDS` (registry.py comment) is for jobs "a user directly observes ingest progress, chat/oracle output…" — i.e. jobs the user triggers and watches. Dawn write is ambient/autonomous, not triggered by a user action. It MUST still be in `DEFAULT_WORKER_ALLOWED_JOB_KINDS` (and therefore in the three deploy files) since it runs in production. The `test_config.py` test (`test_default_worker_allowlist_matches_registry_and_user_facing_jobs`) only enforces that `USER_FACING_JOB_KINDS ⊆ DEFAULT_WORKER_ALLOWED_JOB_KINDS` — it does not enforce the reverse, so non-user-facing kinds in the allowlist are fine.

---

## 9. What dies

Nothing is deleted by this cutover. It is additive:
- New table, new ORM model, new service, new task, new job, new API routes, new BFF routes, new component.
- Widened `ck_llm_calls_owner_kind` CHECK.
- `DailyNotePaneBody.tsx` is modified (additive) — the dawn write fetch + render are additions, not replacements.

Deliberate non-deletion: `DailyNotePaneBody.tsx` itself survives until sibling #7 retires it.

---

## 10. Sibling cutovers and sequencing

- **#1 `machine-hand-hard-cutover.md` must land first.** `MachineText`, `--font-machine`, and the `MarkdownMessage` inheritance are prerequisites (P-1). #4 renders through `MachineText`; without it the block has no machine register.
- **#7 `daily-surface-consolidation-hard-cutover.md` changes where #4 renders.** When #7 kills `DailyNotePaneBody` and routes daily pages through the Notes/Page pane, it must carry the `DawnWriteBlock` render and the `fetchDawnWrite` call into its new host. #7 is a consumer of #4's component; #4 does not depend on #7.
- **#10 `machine-output-in-place-hard-cutover.md`** and **#8 `reader-sidecar-consolidation-hard-cutover.md`** both touch `MachineText` consumers. No shared file with #4. Disjoint scope.
- **Sibling #2 `running-journal-hard-cutover.md`** (RunningHead / SectionOpener) has no shared file with #4. The `DawnWriteBlock`'s `DAWN ·` signature is internal to `MachineText`'s `MachineSignature` and is not a running-head element.

---

## 11. Slices

Each independently buildable; later slices depend on earlier ones.

**S0 — Migration + ORM model.**
Create `0169_dawn_write_artifact.py`, add `DawnWrite` to `db/models.py`, widen `ck_llm_calls_owner_kind` in models.py, widen `LlmCallOwner.kind` Literal in `services/llm_ledger.py` to add `"dawn_write"`.
*Verify:* `bun run test:migrations` green; model imports without error; `pyright` on `db/models.py` and `services/llm_ledger.py` 0.

**S1 — Backend service (`services/dawn_write.py`) + public accessor.**
`collect_signals(db, user_id, local_date, tz) -> DawnWriteSignals | None` (returns None if all signals empty). `generate_dawn_write(db, user_id, local_date, tz, llm) -> DawnWrite`. Queries A/B/C (Signal C calls `is_artifact_stale` from `services/library_intelligence.py`), builds prompt, calls `LedgeredLLM.generate()`, inserts `dawn_writes` row. No `ON CONFLICT` — caller checks for existing row. Also add `is_artifact_stale` public accessor to `services/library_intelligence.py` in this slice.
*Verify:* focused unit tests with DB fixtures; pyright 0; ruff 0.

**S2 — Worker task and registry.**
`tasks/dawn_write.py`: `dawn_write_sweep()` using `run_llm_task`. `jobs/registry.py`: add `dawn_write_job` definition (`periodic_interval_seconds = settings.dawn_write_schedule_seconds`), handler, `config.py` `dawn_write_schedule_seconds` field (default `3600`). Update `DEFAULT_WORKER_ALLOWED_JOB_KINDS` in `config.py`. Update `deploy/env/env-prod-worker.example` and `deploy/hetzner/sync-env.sh` SAFE allowlist.
*Verify:* `test_config.py:test_default_worker_allowlist_matches_registry_and_user_facing_jobs` green; `sync-env.sh` SAFE string updated; pyright 0.

**S3 — FastAPI routes.**
Add to `api/routes/notes.py`: `GET /notes/dawn-write` and `POST /notes/dawn-write/{write_id}/dismiss`. Schema: `DawnWriteOut(id, body_md, generated_at, dismissed_at)`; envelope always `{"write": DawnWriteOut | null}`. `DAWN_WRITE_ENABLED` config guard on the GET route (return `{"write": null}` when disabled rather than 404).
*Verify:* focused integration test for GET (found → `{"write": {...}}`; not-found → `{"write": null}`; disabled → `{"write": null}`) and POST dismiss (idempotent 204); pyright 0; ruff 0.

**S4 — BFF routes.**
Add `apps/web/src/app/api/notes/dawn-write/route.ts` (GET proxy) and `apps/web/src/app/api/notes/dawn-write/[writeId]/dismiss/route.ts` (POST proxy). Add `fetchDawnWrite` and `dismissDawnWrite` to `lib/notes/api.ts`.
*Verify:* `proxy-routes.test.ts` updated; `bun run typecheck` 0; new BFF routes appear in `bun run build` without bundle-budget regression.

**S5 — `DawnWriteBlock` component.**
`components/notes/DawnWriteBlock.tsx` + `DawnWriteBlock.module.css` + `DawnWriteBlock.test.tsx`. Requires P-1 (MachineText).
*Verify:* `DawnWriteBlock.test.tsx` (Chromium): block renders with machine register + `DAWN ·` signature; dismiss button triggers `dismissed_at=null→hidden` optimistic update; `data-testid="dawn-write-block"` present; dismissed write renders nothing; `MarkdownMessage` inside `MachineText` (gate from sibling #1 passes); dismiss button in `--font-sans` (control-bleed).

**S6 — Integration into `DailyNotePaneBody.tsx`.**
Add `dawnWriteResource` `useResource` fetch. Render `{dawnWrite && <DawnWriteBlock write={dawnWrite} />}` above `<PagePaneBody>`.
*Verify:* `DailyNotePaneBody.test.tsx`: with a mock `fetchDawnWrite` returning a write → block renders; with `null` → no block; with a dismissed write → no block; dawn write fetch error → no block (note still loads). `bun run typecheck` 0; `bun run test:unit && bun run test:browser` green; `bun run build` (bundle budget unchanged — `DawnWriteBlock` is in an already-lazy pane chunk).

---

## 12. Acceptance criteria (testable)

- **AC-1.** `POST /notes/dawn-write/{id}/dismiss` with a valid write id returns 204; subsequent `GET /notes/dawn-write?local_date=...` for the same user+date returns a row with `dismissed_at` non-null.
- **AC-2.** A second `POST .../dismiss` for the same already-dismissed write returns 204 (idempotent).
- **AC-3.** `GET /notes/dawn-write?local_date=...` for a date with no row returns `{"write": null}` (not 404). For a date with a row, returns `{"write": {"id": ..., ...}}` — the `write` key is always present in both cases.
- **AC-4.** The dawn write job sweep skips a user with no `daily_note_pages` rows (no timezone record → no generation, no error).
- **AC-5.** The dawn write job sweep skips a user if a `dawn_writes` row for today already exists (idempotent, no duplicate write).
- **AC-6.** If all three content signals are empty for a user, no `dawn_writes` row is created and no `llm_calls` row is written.
- **AC-7.** A generated `dawn_writes.body_md` is ≤200 words; `llm_calls.owner_kind = 'dawn_write'` and `owner_id = dawn_writes.id` (ledger link).
- **AC-8.** `DawnWriteBlock` renders with `[data-machine-origin="Dawn"]` (from `MachineText`'s `data-machine-origin` stamping), a visible `DAWN · <hh:mm>` signature, and `data-testid="dawn-write-block"`.
- **AC-9.** The dismiss button in `DawnWriteBlock` is in `--font-sans` (control-bleed containment: it is outside `MachineText`).
- **AC-10.** `DAWN_WRITE_ENABLED=false` makes the job handler return immediately without querying the DB or calling the LLM.
- **AC-11.** `DEFAULT_WORKER_ALLOWED_JOB_KINDS` in `config.py`, `env-prod-worker.example`, and `sync-env.sh` SAFE allowlist all include `dawn_write_job`. `test_config.py:test_default_worker_allowlist_matches_registry_and_user_facing_jobs` passes.
- **AC-12.** The `ck_llm_calls_owner_kind` CHECK includes `'dawn_write'` (enforced by migration 0169 and mirrored in `db/models.py`).

---

## 13. Negative gates (grep-able assertions)

Implemented in `python/tests/test_dawn_write_guards.py` (backend, node-unit style with raw file reads) and in `apps/web/src/lib/notes/dawnWriteCutover.guards.test.ts` (frontend node unit, following `machineHandCutover.guards.test.ts` pattern).

**Backend guards:**

1. **No `ON CONFLICT` insert.** `services/dawn_write.py` contains no `ON CONFLICT` clause on its INSERT path (house doctrine: no upserts — the existence check is explicit).
   `grep -n "ON CONFLICT" python/nexus/services/dawn_write.py` → zero hits.

2. **No `rowcount` control flow.** `services/dawn_write.py` and `api/routes/notes.py` contain no `rowcount` or `.rowcount` read.

3. **Ledger owner kind is correct.** `tasks/dawn_write.py` passes `owner_kind='dawn_write'` to `LlmCallOwner` (not `'synapse_scan'` or any other kind).

4. **Deploy allowlist triple-consistency.** Assert (in `test_config.py`, new test `test_dawn_write_job_in_all_allowlists`) that `"dawn_write_job"` appears in:
   - `DEFAULT_WORKER_ALLOWED_JOB_KINDS` (config.py:29 area)
   - `deploy/env/env-prod-worker.example` `WORKER_ALLOWED_JOB_KINDS` value
   - `deploy/hetzner/sync-env.sh` `SAFE_WORKER_ALLOWED_JOB_KINDS` value
   Grep all three files; fail if any omits it.

**Frontend guards:**

5. **DawnWriteBlock uses MachineText.** `components/notes/DawnWriteBlock.tsx` imports `@/components/ui/MachineText` (the gate from machine-hand cutover applies; dawn write is in scope for the "prose can't skip the register" rule).

6. **Dismiss button is outside MachineText.** In `DawnWriteBlock.tsx`, the `<button ... aria-label="Dismiss dawn write">` element does not appear as a descendant of the `<MachineText>` render (source-level check: the button JSX is not nested inside the `MachineText` opening tag's scope). This is the control-bleed assertion.

7. **No `dismissed_at` check absent from the render guard.** `DawnWriteBlock.tsx` checks `dismissed_at` in its render guard (either via the `useState(write.dismissed_at !== null)` init or via an explicit `if (dismissed) return null` before rendering MachineText). Absence of this check would make the block re-render on dismissed writes.

---

## 14. Test plan

**Backend (pytest):**
- `python/tests/services/test_dawn_write.py` — unit + focused integration:
  - `collect_signals` returns None when all three signals are empty.
  - `collect_signals` returns correct signal counts from fixture data.
  - `generate_dawn_write` inserts a `dawn_writes` row and a `llm_calls` row (mock LLM call using the existing `real_media_fixture_llm` pattern).
  - Sweep skips user with no `daily_note_pages`.
  - Sweep skips user with existing today row.
  - API: GET returns null for missing date; returns row for existing; returns with `dismissed_at` after dismiss; second dismiss is 204.
- `python/tests/test_dawn_write_guards.py` — file-level assertions (§13 backend gates 1–4).
- `python/tests/test_config.py` — add `test_dawn_write_job_in_all_allowlists` (§13 gate 4).

**Frontend (vitest):**
- `DawnWriteBlock.test.tsx` (Chromium browser project, `.test.tsx`):
  - Renders with machine register and `DAWN · <time>` signature.
  - Dismiss button click → block unmounts optimistically.
  - Dismissed write (`dismissed_at` non-null) → renders nothing.
  - `data-testid="dawn-write-block"` and `[data-machine-origin="Dawn"]` present.
  - Control-bleed: dismiss button has `font-family` from `--font-sans`.
- `DailyNotePaneBody.test.tsx` (existing — extend):
  - Intercept `fetchDawnWrite` at the fetch boundary (`vi.spyOn(globalThis, "fetch")` returning a fixture `{ write: {...} }` for the `/api/notes/dawn-write` URL) → block renders above the page body in both the shellPageId path and the daily-fetch path.
  - Fixture returning `{ write: null }` → no block, page renders fine.
  - Fixture throwing a network error → no block, page still renders (fault isolation).
  (Do not use `vi.mock("@/lib/notes/api")` — mocking internal modules bypasses the codepath under test; testing standards §7 prohibit it.)
- `dawnWriteCutover.guards.test.ts` (node unit, §13 frontend gates 5–7).

**Not run (house pattern, noted):** e2e / CSP — no route-group or header change; heavy suites deferred. The BFF proxy routes follow the existing `proxyToFastAPI` pattern, covered by `proxy-routes.test.ts`.

**Ladder:** `bun run typecheck && bun run lint`; focused `DawnWriteBlock` + `DailyNotePaneBody` tests + guard tests; `bun run test:unit && bun run test:browser`; `bun run build` (bundle budget); `make test-back` with focused suite; full `make test-back-integration` as final gate.

---

## 15. Files (touched / created / deleted)

**Created:**
- `migrations/alembic/versions/0169_dawn_write_artifact.py`
- `python/nexus/services/dawn_write.py`
- `python/nexus/tasks/dawn_write.py`
- `python/tests/services/test_dawn_write.py`
- `python/tests/test_dawn_write_guards.py`
- `apps/web/src/app/api/notes/dawn-write/route.ts`
- `apps/web/src/app/api/notes/dawn-write/[writeId]/dismiss/route.ts`
- `apps/web/src/components/notes/DawnWriteBlock.tsx`
- `apps/web/src/components/notes/DawnWriteBlock.module.css`
- `apps/web/src/components/notes/DawnWriteBlock.test.tsx`
- `apps/web/src/lib/notes/dawnWriteCutover.guards.test.ts`
- This spec.

**Modified:**
- `python/nexus/db/models.py` — add `DawnWrite` ORM class; widen `ck_llm_calls_owner_kind` string constant.
- `python/nexus/services/llm_ledger.py` — widen `LlmCallOwner.kind` Literal to add `"dawn_write"` (parallel to the `ck_llm_calls_owner_kind` widen in migration 0169; pyright rejects any `LlmCallOwner(kind="dawn_write", ...)` call until this line is updated).
- `python/nexus/services/library_intelligence.py` — add thin public accessor `is_artifact_stale(db, *, library_id, current_revision_id) -> bool` wrapping `_compute_freshness`; cross-module callers (dawn_write.py) must use this, not `_compute_freshness` directly.
- `python/nexus/jobs/registry.py` — add `dawn_write_job` `JobDefinition` + `_run_dawn_write_sweep` handler.
- `python/nexus/config.py` — add `dawn_write_schedule_seconds: int = Field(default=3600, alias="DAWN_WRITE_SCHEDULE_SECONDS")`; add `dawn_write_enabled: bool = Field(default=True, alias="DAWN_WRITE_ENABLED")`; append `"dawn_write_job"` to the `DEFAULT_WORKER_ALLOWED_JOB_KINDS` tuple at line 29.
- `python/nexus/api/routes/notes.py` — add GET `/notes/dawn-write` and POST `/notes/dawn-write/{write_id}/dismiss`.
- `python/tests/test_config.py` — add `test_dawn_write_job_in_all_allowlists`.
- `deploy/env/env-prod-worker.example` — append `dawn_write_job` to `WORKER_ALLOWED_JOB_KINDS`; add `# DAWN_WRITE_ENABLED=true` comment.
- `deploy/hetzner/sync-env.sh` — append `dawn_write_job` to `SAFE_WORKER_ALLOWED_JOB_KINDS` (line 16).
- `apps/web/src/lib/notes/api.ts` — add `fetchDawnWrite`, `dismissDawnWrite`, `DawnWrite` type.
- `apps/web/src/app/(authenticated)/daily/DailyNotePaneBody.tsx` — add `dawnWriteResource` fetch + `DawnWriteBlock` render.
- `apps/web/src/app/api/notes/daily/route.ts` — no change (it already proxies `/notes/daily`; the new `/notes/dawn-write` is a separate BFF file).

**Deleted:** none.

---

## 16. Risks

- **R1. Deploy allowlist landmine.** The `SAFE_WORKER_ALLOWED_JOB_KINDS` literal in `deploy/hetzner/sync-env.sh:16` is checked on every deploy by `sync-env.sh:239-240`. If `dawn_write_job` is missing from that string, the deploy fails with "WORKER_ALLOWED_JOB_KINDS is not the safe production allowlist." This is a test gate (§13 gate 4) and enumerated here. *Mitigation:* the guard test `test_dawn_write_job_in_all_allowlists` reads all three files and fails CI before a deploy is attempted.

- **R2. Timezone staleness.** The job uses the most recent `daily_note_pages.time_zone` record. If the user travels and their browser timezone changes, the next daily-note visit will update the record; until then, the dawn write may be generated for the wrong local date. *Mitigation:* this is accepted behavior; the `daily_note_pages.time_zone` column is the only honest timezone record in the system, and it self-corrects on next visit.

- **R3. LLM call on zero signals skipped but job still runs.** The sweep job marks as succeeded even when all users are skipped. The `background_jobs` prune job cleans succeeded rows within `BACKGROUND_JOB_PRUNE_SUCCEEDED_AFTER_DAYS`. *Mitigation:* no change needed; the prune job already handles this.

- **R4. `MarkdownMessage` inside `MachineText` inherits mono face.** This is intentional (per machine-hand spec §4.4), but if the dawn write body contains code fences, they'll be mono-in-mono. *Mitigation:* the prompt rules prohibit code fences; the text is reflective prose only. If the model violates this, the block renders oddly but not broken.

- **R5. Sibling #7 migration path.** If #7 deletes `DailyNotePaneBody` without carrying the dawn write, the block silently disappears. *Mitigation:* this spec explicitly states in P-8 and §10 that #7 must carry it; the sibling sequencing section of this spec is binding guidance to that spec author. The `DawnWriteBlock` component itself has no dependency on `DailyNotePaneBody` — it can be imported anywhere.

- **R6. `dismissed_at` optimistic failure on network error.** If `dismissDawnWrite` fails silently (AC-8 behavior), the block reappears on next page load. *Mitigation:* this is the deliberate decision (D-6). A dismiss failure is a minor cosmetic annoyance, not a data integrity issue.
