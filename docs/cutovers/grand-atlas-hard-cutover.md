# The Grand Atlas — the whole library as one celestial chart — Hard Cutover

**Status:** Spec · Rev 1 · 2026-07-07
**Type:** Hard cutover — no legacy code, no fallbacks, no compat shims, no flags-for-old-behavior.

## One-line

A new `/atlas` pane renders the entire library as an engraved celestial chart — corpus base layer
(works positioned by PCA of their embeddings), readings layer (oracle folios at their existing
FNV-1a celestial positions), constellation boundaries as MST hairlines (libraries), faint synapse
context lines, and red-gold contradiction lines — replacing the oracle-scoped readings-only atlas
and making it the second escape of the manuscript register from the Oracle.

---

## 0. Prerequisites (hard, no fallback)

- **P-1.** Content embedding infrastructure is live: `content_chunks` (`owner_kind IN ('media',
  'note_block')`) and `content_embeddings` (`embedding_vector PGVector(256)`, nullable,
  `chunk_id FK content_chunks.id`) exist at `db/models.py:2825` and `:2915`. The `avg()`
  aggregate on `vector` type is standard since pgvector 0.5.0; the installed pgvector:pg15 Docker
  image ships ≥ 0.6.0. Verified at build time: `SELECT avg('{0.1}'::vector(1))` against the
  migration target DB.
- **P-2.** `library_entries` (`library_id, media_id nullable, podcast_id nullable`,
  `ck_library_entries_exactly_one_target`, `models.py:1930`) is the canonical source for
  constellation membership. Media entries have `media_id IS NOT NULL`.
- **P-3.** `resource_edges` origin CHECK at `models.py:579–586` currently includes
  `'user','citation','system','note_body','highlight_note','synapse','document_embed'`. This spec
  adds NO new origin. Atlas positions live in a dedicated table, not in edges.
- **P-4.** The pane render registry (`lib/panes/paneRenderRegistry.tsx`), route model
  (`lib/panes/paneRouteModel.ts`), and destination registry
  (`lib/navigation/destinations.ts:DESTINATIONS`) are the stable extension points used by all
  existing pane routes. No new primitives required.
- **P-5.** `highlights` table has `anchor_media_id FK media.id` (`models.py:3432`). A cheap
  `COUNT(*)` over `highlights WHERE anchor_media_id = :media_id AND user_id = :user_id` gives
  magnitude phase 1.
- **P-6.** `numpy` is NOT a dependency of the backend (`pyproject.toml` verified — no numpy,
  scipy, or umap in `dependencies` or `dev`). The PCA implementation is pure Python (~60 lines).

---

## 1. Problem (grounded diagnosis)

### 1.1 The existing atlas maps only oracle readings, not the library

`AtlasPaneBody.tsx` (currently at `app/(oracle)/oracle/atlas/AtlasPaneBody.tsx:243`) fetches from
`/api/oracle/readings` — the list of oracle folio sessions. Stars are folios; magnitude is folio
status; constellation lines are concordance peers from `/api/oracle/readings/:id/concordance`.
The entire corpus of ingested works — their embeddings, highlight density, library membership,
synapse edges, stance connections — is invisible. A reader with 400 books sees only the dozen or
so they've consulted the oracle about. The surface cannot express `docs/scriptorium.md §VII`'s
vision of "an engraved star chart of everything you've read."

### 1.2 No persistent spatial substrate exists for the corpus

There is no table recording where each work sits in the conceptual space of the library. Every
ambient feature that could benefit from a geometric understanding of the corpus — visual proximity,
constellation membership, edge routing — must re-derive positions from scratch or approximate them
with keyword similarity. The absence of `media_atlas_positions` means the atlas is computationally
blocked from representing the corpus even if the rendering existed.

---

## 2. Target behavior (user-facing)

- Pressing **Atlas** in the nav rail or Launcher opens a full-bleed celestial chart pane at `/atlas`.
- Works are **stars**; size encodes highlight density (faint = 0 highlights, glimmer = 1–4, bright
  = 5+). Works with no embeddings (pending ingest, `no_text`) drift to the **Nebula** — an
  unplaced fringe arc at the chart's outer rim.
- **Libraries** are **constellations**: a faint hairline MST connects a library's member works. The
  library name floats as a quiet small-caps label in IM Fell italic beside the constellation's
  centroid.
- **Synapse context edges** between works render as barely-visible lines (~0.1 alpha,
  `--oracle-gold` color).
- **Contradicts edges** render in a distinct warm red-gold (`--atlas-contradicts-line`; defined in
  the module as `color-mix(in oklab, var(--oracle-gold, #c39a4d) 45%, #6b2a2a 55%)`).
- **Layer toggles**: quiet small-caps text buttons `CORPUS` and `READINGS` switch the two layers.
  CORPUS = PCA-positioned works + constellations + synapse/contradicts lines. READINGS = oracle
  folio stars at their existing FNV-1a celestial positions + concordance peer lines (the existing
  mechanism). Both default on. The readings layer is highlighted when the pane opens from
  `/atlas?layer=readings`.
- **Hover**: a star tooltip appears near the star (title · kind · highlight count). No popup
  chrome; `background: var(--oracle-paper-faint, rgba(18,12,5,0.72))` surface wash and
  `font-family: var(--font-oracle-body)` for the label text, inside `[data-theme="oracle"]`.
- **Click**: `requestOpenInAppPane('/media/${media_id}')` opens the work in a new pane. The
  chart does not navigate itself.
- `/oracle/atlas` **redirects** to `/atlas?layer=readings`. The `oracleAtlas` route id must not
  exist in any pane registration file (it was never registered; G3 gate enforces absence).

---

## 3. Goals / Non-goals

### Goals

- **G1.** `media_atlas_positions(media_id, x, y, projection_version, computed_at)` — a new
  persistent spatial substrate for the corpus.
- **G2.** `atlas_project_job` — a periodic (nightly) background job that computes 256-dim mean
  embeddings per media via pgvector `avg()`, projects to 2D via pure-Python power-iteration PCA,
  normalizes, runs one bounded repulsion pass, and upserts positions.
- **G3.** `GET /atlas` — a server-built read model with `{stars, constellations, edges}`,
  user-scoped, ETag-cacheable by `max(computed_at)`.
- **G4.** A new `/atlas` pane (`PaneRouteId` `atlas`, DESTINATIONS primary slot) that renders the
  grand atlas canvas, fully adopting the oracle manuscript register via `OracleThemeWrapper`.
- **G5.** Reuse `AtlasPaneBody`'s star-drawing, dome, drag/rotate, and hit-test machinery
  (enumerating reused vs rewritten in §7).
- **G6.** Both CORPUS and READINGS layers on the same celestial-dome canvas. Stars with no
  atlas position (Nebula) appear at a rim-band hash position.
- **G7.** `/oracle/atlas` redirects to `/atlas?layer=readings`; `oracleAtlas` route id is never
  registered (it does not exist in pane files; G3 gate enforces absence).
- **G8.** Negative gates: no numpy in the projection service; sole writer of `media_atlas_positions`
  is `atlas_project_job`; no `oracleAtlas` in the route model.

### Non-goals

- **N1.** No attention-ledger dwell signal yet — magnitude uses highlight count (soft upgrade to
  dwell named; cite `attention-ledger-hard-cutover.md` SPEC).
- **N2.** No minimap, no zoom chrome beyond wheel/pinch — spare instrument.
- **N3.** No new resource_edges origin (graph writes are synapse's job).
- **N4.** No animated layout transitions when projection_version changes — positions update
  discretely via version bump only (D-4).
- **N5.** No filtering, no search within the atlas pane — the Launcher is the search instrument.
- **N6.** No LLM call — atlas projection is pure computation; `ck_llm_calls_owner_kind` is
  unchanged.
- **N7.** Synapse `supports`-stance edges excluded from the atlas (phase 1 scope). `AtlasEdgeOut.kind`
  encodes only `"context" | "contradicts"` — a future phase may add a third visual treatment.

---

## 4. Architecture and final state

### 4.1 Ownership table

| Concern | Sole owner (final) | Replaces |
|---|---|---|
| `media_atlas_positions` writer | `services/atlas_projection.py` (via `atlas_project_job`) | (new) |
| Atlas read model | `api/routes/atlas.py` (`GET /atlas`) | (new; supersedes `/oracle/atlas` pane) |
| Grand atlas canvas | `app/(authenticated)/atlas/GrandAtlasPaneBody.tsx` | `AtlasPaneBody.tsx` (oracle-only) |
| Corpus layer rendering | `GrandAtlasPaneBody.tsx` (extends drawn-star kit) | (new) |
| Readings layer rendering | `GrandAtlasPaneBody.tsx` (delegates to `projection.ts` FNV-1a path) | `AtlasPaneBody.tsx` |
| MST constellation lines | `lib/atlas/constellationMst.ts` (client, pure) | (new) |
| Corpus star magnitude | `lib/atlas/corpusMagnitude.ts` (client, pure) | `starMagnitude` (folio-status-only) |
| `/atlas` pane route | `paneRouteModel.ts` `atlas` id | oracle-scoped route group (not a pane route) |

### 4.2 Coordinate system (binding)

`media_atlas_positions` stores `x real, y real` where both are in `[0.0, 1.0]` (normalized after
PCA + repulsion). The canvas layer maps these to a celestial position:

```
azimuth  = x × 2π
altitude = ZENITH_MARGIN + y × ALTITUDE_SPAN
```

using the same constants as `projection.ts` (`ZENITH_MARGIN = π/2 × 0.06`,
`ALTITUDE_SPAN = π/2 − ZENITH_MARGIN − HORIZON_RIM_MARGIN`). The existing `projectToScreen`
function then handles both corpus and readings stars identically. Corpus stars therefore rotate
with the camera, participate in the idle drift, and respond to drag — the whole dome UX transfers.

**Nebula position**: a media with no `media_atlas_positions` row gets a Nebula position derived
from `fnv1a(media_id.hex) / HASH_NORMALIZER * 2π` for azimuth and `altitude = HORIZON_RIM_MARGIN
× 0.4` (just inside the rim but below the main field). This is computed client-side from the
star's `media_id` when `x == null`.

### 4.3 Layer model

| Layer | Source | Coordinate basis | Toggle button |
|---|---|---|---|
| CORPUS | `/api/atlas` `stars` (x/y) + `constellations` + `edges` | PCA → celestial (§4.2) | `CORPUS` |
| READINGS | `/api/oracle/readings` (existing endpoint, `FolioStarInput`) | FNV-1a `projection.ts:celestialPosition` | `READINGS` |

Both render on the same dome with the same `projectToScreen` and `cameraAzimuth`. A `layer=readings`
URL param sets `readingsHighlighted: true` in the initial layer state (both layers on; the readings
stars draw at 1.5× glow boost to distinguish them from corpus stars for the same work).

### 4.4 OracleThemeWrapper

This spec creates `app/(authenticated)/atlas/OracleThemeWrapper.tsx` as a standalone 6-line
component (`data-theme="oracle"` `display:contents`). This is the primary definition; it is not
a shim for another spec. When `oracle-shell-dissolution-hard-cutover.md` is built, it should
import `OracleThemeWrapper` from this path (`@/app/(authenticated)/atlas/OracleThemeWrapper`)
rather than defining its own copy. No build-order branching required.

---

## 5. Data model / migration

**Migration filename**: `NNNN_grand_atlas.py` (number assigned at build time — main ends at 0168,
sibling dawn-write spec claims 0169, unmerged branch `codex/search-retrieval-roadmap` claims
0168–0173 and renumbers at merge).

```sql
CREATE TABLE media_atlas_positions (
  media_id          uuid      PRIMARY KEY
                              REFERENCES media(id) ON DELETE CASCADE,
  x                 real      NOT NULL
                              CHECK (x >= 0.0 AND x <= 1.0),
  y                 real      NOT NULL
                              CHECK (y >= 0.0 AND y <= 1.0),
  projection_version int      NOT NULL DEFAULT 1
                              CHECK (projection_version >= 1),
  computed_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE media_atlas_positions IS
  'Persistent 2D position for each work in the grand atlas, produced by the
   atlas_project_job PCA projection. x/y in [0,1]; maps to celestial coords
   at render time (see grand-atlas-hard-cutover.md §4.2). Sole writer:
   services/atlas_projection.py.';

CREATE INDEX ix_media_atlas_positions_version
  ON media_atlas_positions (projection_version);
```

`downgrade()`: drop the table. No FK breadcrumb exists — `media` cascade-deletes rows on media
deletion.

**Model** (`db/models.py`): add `MediaAtlasPosition` mapped class with `media_id` (PK, FK
`media.id` CASCADE), `x`, `y` (Float, NOT NULL), `projection_version` (Integer, NOT NULL,
default=1), `computed_at` (TIMESTAMP tz, server_default now()), `CheckConstraint("x >= 0.0 AND x
<= 1.0", name="ck_media_atlas_positions_x_range")`,
`CheckConstraint("y >= 0.0 AND y <= 1.0", name="ck_media_atlas_positions_y_range")`,
`CheckConstraint("projection_version >= 1", name="ck_media_atlas_positions_version_positive")`.

---

## 6. API

| Method | Route | Auth | Behavior |
|---|---|---|---|
| GET | `/atlas` | bearer | Returns `AtlasOut`; ETag = hex of `max(computed_at)` over all returned stars; `If-None-Match` → 304 |
| GET | `/atlas/status` | bearer | Returns `{projection_version: int \| null, positioned_count: int, total_count: int, stale_count: int, last_run: str \| null}` for the UI's "chart is computing" state |
| POST | `/atlas/project` | bearer | Enqueues `atlas_project_job` for the requesting user; 202 `{queued: bool}` |

`AtlasOut` schema (`schemas/atlas.py`):
```python
class StarOut(BaseModel):
    media_id: UUID
    x: float | None   # None = Nebula (no atlas position)
    y: float | None
    title: str
    kind: str          # 'web_article' | 'epub' | 'pdf' | 'video' | 'podcast_episode'
    magnitude: int     # highlight count (phase 1; named upgrade: dwell from attention-ledger)

class ConstellationOut(BaseModel):
    library_id: UUID
    name: str
    member_media_ids: list[UUID]

class AtlasEdgeOut(BaseModel):
    source_media_id: UUID
    target_media_id: UUID
    kind: Literal["context", "contradicts"]
    origin: str        # 'synapse' | 'user' | etc.

class AtlasOut(BaseModel):
    stars: list[StarOut]
    constellations: list[ConstellationOut]
    edges: list[AtlasEdgeOut]
```

**Stars query** (single user, permission-scoped via `library_entries`):
```sql
SELECT m.id, m.title, m.kind,
       p.x, p.y,
       COUNT(DISTINCT h.id) AS magnitude
FROM media m
JOIN library_entries le ON le.media_id = m.id
JOIN libraries l ON l.id = le.library_id
LEFT JOIN media_atlas_positions p ON p.media_id = m.id
LEFT JOIN highlights h
       ON h.anchor_media_id = m.id AND h.user_id = :user_id
WHERE l.user_id = :user_id
GROUP BY m.id, m.title, m.kind, p.x, p.y
```

**Constellations query**:
```sql
SELECT l.id, l.name, array_agg(le.media_id) AS member_media_ids
FROM libraries l
JOIN library_entries le ON le.library_id = l.id
WHERE l.user_id = :user_id AND le.media_id IS NOT NULL
GROUP BY l.id, l.name
```

**Edges query** — both endpoints must be user-visible media:
```sql
SELECT re.source_id, re.target_id, re.kind, re.origin
FROM resource_edges re
WHERE re.user_id = :user_id
  AND re.source_scheme = 'media'
  AND re.target_scheme = 'media'
  AND (
      (re.origin = 'synapse' AND re.kind = 'context')
      OR re.kind = 'contradicts'
  )
  AND re.source_id IN (SELECT m.id FROM media m JOIN library_entries le ON le.media_id = m.id JOIN libraries l ON l.id = le.library_id WHERE l.user_id = :user_id)
  AND re.target_id IN (SELECT m.id FROM media m JOIN library_entries le ON le.media_id = m.id JOIN libraries l ON l.id = le.library_id WHERE l.user_id = :user_id)
```

ETag: `hashlib.md5((max_computed_at.isoformat() if max_computed_at else "empty").encode()).hexdigest()`
— NULL guard required (fresh install: no `atlas_project_job` run → `MAX(p.computed_at)` is NULL →
`AttributeError` without guard). `test_atlas.py` covers the all-Nebula case (valid ETag, all `x:null`).

**Edges scope:** `context` is synapse-scoped (sole writer). `contradicts` from **any** origin is
surfaced — stance judgments are user-visible regardless of author. `AtlasEdgeOut.origin: str`
passes through for optional FE styling. Synapse `supports` edges are excluded (N7).

Route file: `python/nexus/api/routes/atlas.py`. Router registered in
`python/nexus/api/routes/__init__.py` as `api_router.include_router(atlas_router)`.

---

## 7. Frontend

### 7.1 Pane registration

| File | Change |
|---|---|
| `lib/panes/paneRouteModel.ts` | Add `"atlas"` with one section header (`destinationId: "atlas"`, `defaultFolio: "pane-label"`), `defaultLabel: "The Atlas"`, `labelMode: "static"`, and `bodyMode: "document"` |
| `lib/panes/paneRouteTable.ts` | Add entry to `PANE_ROUTE_META` with `icon: Map` (from `lucide-react`); route chrome is not registered here |
| `lib/panes/paneRenderRegistry.tsx` | Add `atlas` loader pointing to `(authenticated)/atlas/GrandAtlasPaneBody` |
| `lib/navigation/destinations.ts` | Add `{ id:"atlas", label:"Atlas", href:"/atlas", keywords:["map","chart","library","constellation","stars"], slot:"primary", match:{ exact:["/atlas"], prefix:["/atlas/"] } }` after the `notes` entry |

### 7.2 Reuse vs rewrite accounting (`AtlasPaneBody.tsx`)

**Reused verbatim** (copy into `GrandAtlasPaneBody.tsx`):
- `drawDome`, `drawCardinal`, `drawStars`, `drawConstellation` functions
  — **Note:** when moving `projection.ts`, add `export` to `ZENITH_MARGIN`, `HORIZON_RIM_MARGIN`,
  and `ALTITUDE_SPAN` (currently module-private). `GrandAtlasPaneBody.tsx` uses these for the
  Nebula altitude formula (`HORIZON_RIM_MARGIN × 0.4`); they cannot be imported without this change.
- `styleForMagnitude`, `starColor`, `StarStyle`, `StarMagnitude`, `DrawContext` types
- `IDLE_ROTATION_RAD_PER_SEC`, `STAR_HIT_RADIUS_PX`, `SELECTION_LINGER_MS` constants
- `resolveGeometry`, `hitTest`, resize observer, RAF loop, pointer event handlers
- `onSelectStar` (adapted: opens `/media/${star.media_id}` not `/oracle/${star.id}`)
- `AtlasConcordancePeerLoader` (extracted to its own file — see §15 Created; still used for READINGS layer)
- STAR_COLOR constants (`STAR_COLOR_BRIGHT`, `STAR_COLOR_GLIMMER`, `STAR_COLOR_FAINT`)

**Rewritten / replaced**:
- `useStickyHeadline` usage → deleted (no oracle shell); `headlineRef` removed
- `useRouter` / `router.push('/oracle/...')` → `requestOpenInAppPane('/media/${media_id}')` for corpus stars; `usePaneRouter().push('/oracle/${star.id}')` for readings-layer folio stars navigating to oracle readings
- Data fetching: replaces single `useResource<{data:OracleSummary[]}>` with three resources (stars, oracle-readings for READINGS layer) or a single `GET /atlas` response plus a lazy readings fetch
- `stars` derivation: replaces `placeFolios(readings)` with position mapping from API response (corpus stars from `x/y` → celestial; Nebula stars from FNV-1a of media_id)
- Layer toggle state: `const [layers, setLayers] = useState<{corpus:boolean;readings:boolean}>({corpus:true, readings:urlHasReadingsLayer})`
- Constellation MST drawing: new `drawConstellationMst(d, mstEdges, starPositionMap)` function using pre-computed MST from `constellationMst.ts`
- Edge drawing: new `drawEdges(d, edges, starPositionMap)` draws synapse context (faint) and contradicts (red-gold) as lines
- Constellation label rendering: `ctx.font = "italic small-caps 10px 'IM Fell English', serif"` (canvas font string; CSS vars unparseable in canvas, same caveat as `drawCardinal`)
- `StarLabel` component (corner hover card): adapted from existing to show `title · kind · ${magnitude} highlights`
- `OracleThemeWrapper` wrapper on the pane body root (§4.4)
- Removed: back-to-Aleph link, `Link` to `/oracle`, `headlineRef` div, `readings`-as-`OracleSummary` typing

**New in `GrandAtlasPaneBody.tsx`**:
- `corpusMagnitude` imported from `lib/atlas/corpusMagnitude.ts`: `0 → 'faint', 1–4 → 'glimmer', ≥5 → 'bright'`
- Nebula position from `fnv1a(mediaId.replace(/-/g, '')) / 0xffffffff * Math.PI * 2` for azimuth, fixed altitude `HORIZON_RIM_MARGIN * 0.4`
- Layer toggle buttons: `<button className={styles.layerToggle} aria-pressed={layers.corpus} onClick={() => setLayers(l => ({...l, corpus: !l.corpus}))}>CORPUS</button>` — two buttons, absolute-positioned at bottom-right of the canvas frame
- Corpus star click: `requestOpenInAppPane('/media/${star.media_id}')`
- Readings star click: `usePaneRouter().push('/oracle/${folioStar.id}')` (within-oracle navigation)

### 7.3 `lib/atlas/constellationMst.ts` — Prim MST on celestial positions

Input: `{celestialPositions: Map<string, CelestialPosition>, memberMediaIds: string[]}` per
constellation.
Output: array of `[string, string]` pairs (media ID pairs representing MST edges).

Prim's algorithm, O(N²) on positioned members (N ≤ hundreds per library, safe):
1. Filter `memberMediaIds` to those with a non-Nebula celestial position.
2. Initialize `inMst = {memberIds[0]}`, `edges: [string, string][] = []`.
3. While `inMst.size < memberIds.length`: find the minimum-weight crossing edge (great-circle or
   Euclidean distance on azimuth/altitude); add its target node + the media ID pair.
4. Return edge list.

Computed once per `{stars, constellations}` change in a `useMemo` and stored in a `Ref`. The RAF
loop projects each ID pair to screen coordinates each frame using
`projectToScreen(celestialPosition, camera)` — so constellation lines rotate with the camera and
stay attached to their stars without re-running Prim's. The unit test asserts on media ID pairs,
not screen coordinates.

### 7.4 CSS tokens for edges

In `atlas.module.css`, a scoped custom property:
```css
.surface {
  --atlas-contradicts-line: color-mix(in oklab, var(--oracle-gold, #c39a4d) 45%, #6b2a2a 55%);
  --atlas-synapse-line: var(--oracle-gold, #c39a4d);
}
```
Used in `drawEdges` as `rgba(${getCssRgb(--atlas-contradicts-line)}, 0.6)` — read once at mount
via `getComputedStyle(canvasRef.current.parentElement)`. Canvas cannot use `var()` directly (same
limitation noted in existing `drawCardinal` at `AtlasPaneBody.tsx:144`). Fallback literal values
given in var() fallbacks for oracle-theme-absent environments.

### 7.5 Redirect from `/oracle/atlas`

This spec absorbs the oracle atlas relocation (oracle-shell-dissolution is not yet built). The
existing `app/(oracle)/oracle/atlas/page.tsx` becomes:
```tsx
import { redirect } from "next/navigation";
export default function Page() { redirect("/atlas?layer=readings"); }
```
`app/(oracle)/oracle/atlas/AtlasPaneBody.tsx` is deleted — its readings-only UI is fully absorbed
by `GrandAtlasPaneBody.tsx`'s READINGS layer. When oracle-shell-dissolution is subsequently built,
it should not re-add an atlas pane route; the `oracleAtlas` route id does not exist and must
not be created.

Also update `app/(oracle)/oracle/OracleLandingPaneBody.tsx` line 102: change
`href="/oracle/atlas"` to `href="/atlas?layer=readings"` to avoid the redirect on every click
from the oracle landing page.

### 7.6 BFF proxy

`apps/web/src/app/api/atlas/route.ts` — thin GET + POST proxy (copy pattern from
`app/api/synapse/scans/route.ts`). `app/api/atlas/project/route.ts` — POST proxy for on-demand
projection trigger.

Update `app/api/proxy-routes.test.ts` `API_ROUTE_COUNT` +2.

---

## 8. Key decisions

**D-1. pgvector `avg()` for mean embedding.**
Standard aggregate since pgvector 0.5.0; the installed pgvector:pg15 image ships ≥ 0.6.0. SQL
avg yields a `vector(256)` that SQLAlchemy deserializes via `PGVector` to `list[float]` without
Python-side iteration. For corpora > 500 works this is ~10× faster than fetching all chunk rows
and averaging in Python. *Fallback (if old image):* fetch rows, `[sum(c) / len(c) for c in
zip(*vecs)]` — identical numeric output. Verification command at build time:
`SELECT avg('{0.1,0.2}'::vector(2));` against the migration target.

**D-2. Pure-Python PCA via power iteration (no numpy).**
numpy is absent from pyproject.toml (verified). Power iteration for 2 components on a 256×256
covariance matrix is ~60 lines of Python lists. Each `X @ v` (N × 256 mat-vec) is O(N × 256);
10 iterations × 2 components = ~20 million float ops at N=1000 — completes in ~0.5s in CPython,
acceptable for a nightly job. Deterministic seed: component-1 starts at the unit vector with
index 0 set to 1 (all other entries 0), which is orthogonal to the data mean; component-2 starts
at the orthogonal complement of the first eigenvector. *Rejected:* adding numpy/scipy as a
dependency (bloats the Docker image; violates the single-pyproject.toml constraint); UMAP (much
larger dep, non-deterministic without a fixed seed, no guarantee of positions staying stable
across projection_version bumps). *Rejected:* TSNE (same dependency concerns; also
non-deterministic).

**D-3. Minimal spanning tree for constellation boundaries.**
MST lines over the cluster's star screen positions. *Rejected:* convex hull (requires a
computational geometry library or ~150 lines of Jarvis march; a hull encloses empty space when a
library has a linear arrangement). MST is 30 lines of Prim's, always in the browser (no server
computation), re-projects each frame with zero extra data.

**D-4. Positions update only via `projection_version` bump.**
A new projection version is written only when the job runs a complete re-projection pass. Partial
updates (one new media arrives, gets appended mid-projection) are deferred to the next full run.
This prevents the map from slowly rearranging as items are added, making the topology feel
unstable. A "repositioned N works" notice is intentionally absent — the map just settles
differently after the next nightly run. *Rejected:* incremental append of single-media positions
without full re-projection (would break the PCA invariant that all positions are jointly
normalized).

**D-5. CORPUS layer uses celestial-dome coordinate system, not flat scatter.**
The existing `projectToScreen` / `cameraAzimuth` / drag machinery is wholly reused. Corpus
stars have their normalized `(x, y)` from `media_atlas_positions` mapped to `(azimuth, altitude)`
by the formula in §4.2, making them rotate with the camera exactly like oracle folio stars. A flat
2D scatter plot would require rewriting the interaction model. *Rejected:* flat canvas with pan/zoom
(loses the dome's instrument quality; doubles interaction code).

**D-6. `requestOpenInAppPane('/media/${id}')` for corpus star clicks.**
Clicking a corpus star opens the work in a NEW pane alongside the atlas. The atlas remains
visible. *Rejected:* navigating the atlas pane itself to the media URL (the atlas should stay
open as a navigation instrument, not be replaced by the reader).

**D-7. Magnitude = highlight count, phase 1.**
The cheapest honest signal: `COUNT(*) FROM highlights WHERE anchor_media_id = :id`. Named soft
upgrade: replace with dwell time from `attention-ledger-hard-cutover.md` (SPEC) `reading_sessions`
once that spec is built — the `StarOut.magnitude` field carries the number and the canvas mapping
(`corpusMagnitude`) is already decoupled from the source.

**D-8. Nebula at rim with FNV-1a stable position.**
Media without embeddings (no text extracted, ingest pending) have no `media_atlas_positions` row.
They are included in the `stars` list with `x: null, y: null`. The client computes a stable rim
position from `fnv1a(media_id.hex)` so the same work always appears at the same rim arc. Nebula
stars render at `faint` magnitude and smaller glow, drawn last so they don't occlude corpus stars.
A faint italic "Nebula" label appears at the 6 o'clock rim position. *Rejected:* excluding
Nebula works from the response (a library with 20 unprocessed PDFs would show an incomplete
constellation — confusing).

---

## 9. What dies (exhaustive)

### Deleted files

- `app/(oracle)/oracle/atlas/AtlasPaneBody.tsx` — readings-only body, superseded by READINGS
  layer in GrandAtlasPaneBody
- `app/(oracle)/oracle/atlas/AtlasPaneBody.test.tsx`

### Deleted behaviors

- The readings-only oracle atlas as a standalone pane surface — superseded by the READINGS layer
  in GrandAtlasPaneBody
- `/oracle/atlas` as a pane destination — becomes a redirect to `/atlas?layer=readings`

### Updated callers

- `app/(oracle)/oracle/OracleLandingPaneBody.tsx` — live link `href="/oracle/atlas"` updated to
  `href="/atlas?layer=readings"` (§7.5). The redirect makes it functionally correct, but the
  direct href avoids the redirect on every oracle landing page click.

### Explicitly NOT deleted

- `apps/web/src/app/(oracle)/oracle/atlas/projection.ts` — **moved** to
  `app/(authenticated)/atlas/projection.ts`; see §11.S3.1. The oracle path is deleted as part
  of the move.
- `apps/web/src/app/(oracle)/oracle/atlas/StarLabel.tsx` — moved and adapted for corpus star tooltip
- `app/(oracle)/oracle/atlas/projection.test.ts` — moved alongside `projection.ts`
- `oracle-shell-dissolution-hard-cutover.md`'s non-atlas oracle routes (`oracle`, `oracleReading`) — unaffected
- The `/api/oracle/readings` backend endpoint — still needed for the READINGS layer
- `resource_edges` — no schema change
- `paneRouteModel.ts`, `paneRouteTable.ts`, `paneRenderRegistry.tsx` — `oracleAtlas` was never
  registered in these files (the oracle atlas lives in the `(oracle)` route group, not the pane
  system). G3 negative gate confirms `oracleAtlas` is absent after this spec builds.

---

## 10. Sibling cutovers and sequencing

**DECLARED ABSORBED:** `oracle-shell-dissolution-hard-cutover.md` (SPEC) planned to relocate
the readings-only `AtlasPaneBody` as the `oracleAtlas` pane route. This spec absorbs that work
entirely: ONE Atlas pane at `/atlas` (route id `atlas`, DESTINATIONS primary slot), built before
oracle-shell-dissolution. The `oracleAtlas` route id must never be created. When
oracle-shell-dissolution is subsequently built, it should not touch atlas routes or files (they
are already canonical in `(authenticated)/atlas/`). `OracleThemeWrapper` is defined here
(§4.4) — oracle-shell-dissolution should import from `@/app/(authenticated)/atlas/OracleThemeWrapper`.

- **`oracle-shell-dissolution-hard-cutover.md` (SPEC):** Atlas absorption declared above. All
  other oracle routes (`oracle`, `oracleReading`) are unaffected.
- **`running-journal-hard-cutover.md`:** The final typed header model supersedes
  its standalone standing-head plan. The Atlas route declares its section-header
  destination in the same exhaustive `PANE_ROUTE_MODELS` entry.
- **`machine-hand-hard-cutover.md` (SPEC):** No overlap. The atlas renders no machine output;
  `MachineText` is not used.
- **`two-rooms-hard-cutover.md` (SPEC):** `[data-theme="oracle"]` on the atlas pane is a sibling
  selector to `[data-theme="light"]` and `:root` dark default — disjoint custom-property
  namespaces, no token collision.
- **`synapse-resonance-engine.md` (BUILT):** The atlas reads `resource_edges` where
  `origin='synapse' AND kind='context'`. Synapse is already deployed; no coordination needed.
- **`dawn-write-hard-cutover.md` (SPEC):** Widens `ck_llm_calls_owner_kind`. This spec does NOT
  widen that constraint (no LLM calls in atlas projection). No conflict.
- **`attention-ledger-hard-cutover.md` (SPEC):** Named soft upgrade for `magnitude` — once
  `reading_sessions` exist, `StarOut.magnitude` can switch from highlight count to dwell-ms. No
  blocking dependency; the magnitude field is already decoupled.
- **`browse-surface-deletion-hard-cutover.md` (SPEC):** Deletes `browse` from DESTINATIONS and
  `PaneRouteId`; deleting its route definition also deletes its header contract. No conflict with Atlas.
- **MediaPaneBody.tsx:** The typed pane-header cutover owns media identity and
  removed the old metadata chrome override. This spec does not touch `MediaPaneBody.tsx`.
  No coordination needed.

---

## 11. Slices (each independently buildable)

### S0 — Schema + projection service (no UI)

**Scope:** Migration, `MediaAtlasPosition` model, `atlas_projection.py` service, unit tests.

1. Write migration `NNNN_grand_atlas.py`: create `media_atlas_positions` with constraints.
2. Add `MediaAtlasPosition` to `db/models.py`.
3. Write `python/nexus/services/atlas_projection.py`:
   - `fetch_mean_embeddings(db, user_id) -> list[tuple[UUID, list[float]]]` — runs the `avg()`
     aggregate query, returns `(media_id, mean_vector)` only for user-visible media with at least
     one non-null embedding.
   - `pca_2d(vectors: list[list[float]]) -> list[tuple[float, float]]` — center, power-iteration
     PCA (20 iterations × 2 components), min-max normalize, clamp to [0, 1]. Pure Python. Returns
     `(x, y)` per input vector in the same order.
   - `repulse(positions: list[tuple[float, float]], *, min_dist: float = 0.02) ->
     list[tuple[float, float]]` — one O(N²) pass: for each overlapping pair, push apart along
     their connecting vector. N ≤ 2000 at expected single-user scale; one pass is sufficient for
     legibility.
   - `upsert_positions(db, positions: dict[UUID, tuple[float, float]]) -> int` — UPSERT via
     `INSERT ... ON CONFLICT (media_id) DO UPDATE SET x=EXCLUDED.x, y=EXCLUDED.y,
     projection_version=media_atlas_positions.projection_version+1, computed_at=now()`. Returns
     row count.
   - `run_projection(db, user_id) -> dict` — orchestrates: fetch → PCA → repulse → upsert;
     returns `{"positioned": N, "skipped_no_embeddings": M}`.

4. Write `python/tests/test_atlas_projection.py` — unit test with fixture vectors (3 orthogonal
   256-dim vectors; verify PCA selects the two highest-variance axes; verify normalization yields
   all positions in [0, 1]; verify repulsion separates overlapping positions; test
   `upsert_positions` round-trip against a test DB with a real media row).

*Verify:* `cd python && uv run ruff check . && uv run pyright && NEXUS_ENV=test uv run pytest tests/test_atlas_projection.py -x`; migration: `make test-migrations`.

### S1 — Job registration + periodic trigger

**Scope:** `tasks/atlas_project.py`, `jobs/registry.py`, `config.py`, allowlist files.

1. Write `python/nexus/tasks/atlas_project.py`:
   ```python
   def atlas_project(*, payload: Mapping[str, Any]) -> dict:
       user_id = UUID(payload["user_id"])
       with get_db_session() as db:
           result = run_projection(db, user_id)
           db.commit()
       return result
   ```
   Copy `run_llm_task` shape is NOT needed here (no LLM); simple synchronous pattern.

2. Add to `jobs/registry.py`:
   ```python
   "atlas_project_job": JobDefinition(
       kind="atlas_project_job",
       handler=_run_atlas_project,
       max_attempts=3,
       retry_delays_seconds=(120, 600, 1800),
       lease_seconds=300,
       periodic_interval_seconds=int(settings.atlas_project_schedule_seconds),
   )
   ```

3. Add `atlas_project_schedule_seconds: int = Field(default=86400, alias="ATLAS_PROJECT_SCHEDULE_SECONDS")` to `config.py`. Validator: `≥ 1` (must be a positive number of seconds; to disable the periodic trigger, remove the job from the allowlist rather than setting this to 0).

4. Add `"atlas_project_job"` to `USER_FACING_JOB_KINDS` (projection is user-observable via the status endpoint).

5. On-demand enqueue: in `services/media_intelligence.py` at the media-unit ready-promote site
   (same site where synapse enqueues its scan), call
   `try_enqueue_atlas_project(db, user_id=media.user_id)` — soft enqueue (SAVEPOINT-swallow) with
   dedupe key `atlas_project:{user_id}`, triggered only when the unpositioned count exceeds
   `ATLAS_REPROJECT_TRIGGER_MIN_UNPOSITIONED = 20` (defined in `services/atlas_projection.py`):
   `SELECT count(*) FROM media m LEFT JOIN media_atlas_positions p ON p.media_id = m.id
    WHERE m.id IN (user-visible media) AND p.media_id IS NULL > ATLAS_REPROJECT_TRIGGER_MIN_UNPOSITIONED`.
   # Avoid re-projecting on every single ingest; batch when backlog is meaningful.

6. Propagate `atlas_project_job` to all allowlist files:
   `config.py DEFAULT_WORKER_ALLOWED_JOB_KINDS`, `deploy/hetzner/sync-env.sh` SAFE list,
   `deploy/env/env-prod-worker.example`, `.env.example`,
   `python/tests/test_hetzner_env_sync_validation.py`.

*Verify:* `cd python && NEXUS_ENV=test uv run pytest tests/test_atlas_projection.py -x -m integration` (seeds user + media + embeddings → runs the job → asserts media_atlas_positions rows created); allowlist drift guard: `NEXUS_ENV=test uv run pytest tests/test_hetzner_env_sync_validation.py -x`.

### S2 — Read model (`GET /atlas`)

**Scope:** `schemas/atlas.py`, `api/routes/atlas.py`, BFF proxy, proxy-routes count.

1. Write `python/nexus/schemas/atlas.py` with `StarOut`, `ConstellationOut`, `AtlasEdgeOut`, `AtlasOut`, `AtlasStatusOut`.

2. Write `python/nexus/api/routes/atlas.py`:
   - `GET /atlas` → runs three queries (§6), builds `AtlasOut`, computes ETag, handles 304.
   - `GET /atlas/status` → quick status query.
   - `POST /atlas/project` → `try_enqueue_atlas_project(db, user_id)`, 202.
   Register in `api/routes/__init__.py`.

3. Write integration test `python/tests/test_atlas.py`:
   - Seed user + 3 media in 2 libraries + embeddings + one `media_atlas_positions` row +
     one `resource_edges` (synapse context) + 2 highlights on one media.
   - Assert `GET /atlas` returns `stars` with x/y for positioned media + null for unpositioned;
     `constellations` with correct member_media_ids; `edges` with the synapse edge.
   - Assert magnitude = 2 for the highlighted media.
   - Assert ETag round-trip (304 on second fetch with same ETag).

4. Write BFF proxy `apps/web/src/app/api/atlas/route.ts` (GET + POST, copy synapse pattern) and
   `apps/web/src/app/api/atlas/project/route.ts` (POST). Update `proxy-routes.test.ts` count +2.

*Verify:* `cd python && NEXUS_ENV=test uv run pytest tests/test_atlas.py -x`; `cd apps/web && bun run test:unit` (proxy-routes count).

### S3 — Grand atlas pane + CORPUS layer

**Scope:** `GrandAtlasPaneBody.tsx`, `atlas.module.css`, `projection.ts` move, `constellationMst.ts`, `corpusMagnitude.ts`, pane/destination registration, `(authenticated)/atlas/page.tsx`.

1. Move `projection.ts`, `projection.test.ts`, `StarLabel.tsx`, `atlas.module.css` from
   `app/(oracle)/oracle/atlas/` to `app/(authenticated)/atlas/`. Update internal imports. Add
   `export` to `ZENITH_MARGIN`, `HORIZON_RIM_MARGIN`, `ALTITUDE_SPAN` in `projection.ts`
   (currently private; GrandAtlasPaneBody needs them for Nebula altitude). Extract
   `AtlasConcordancePeerLoader` to `app/(authenticated)/atlas/AtlasConcordancePeerLoader.tsx`
   before deleting `AtlasPaneBody.tsx`.

2. Write `lib/atlas/constellationMst.ts` (Prim MST) and `lib/atlas/corpusMagnitude.ts`.

3. Write `GrandAtlasPaneBody.tsx`: adapts AtlasPaneBody (§7.2) — CORPUS layer data from
   `useResource<AtlasOut>({cacheKey:'atlas', path:()=>'/api/atlas'})`, READINGS layer from
   `useResource<{data:FolioStarInput[]}>({cacheKey:'oracle-readings', path:()=>'/api/oracle/readings'})` (loaded lazily only when readings layer is on); layer toggles; Nebula rendering;
   `requestOpenInAppPane('/media/${star.media_id}')` on corpus click; `usePaneRouter().push`
   for readings folio clicks; `OracleThemeWrapper` wrapper.

4. Add pane route, destination, and render registry entries (§7.1). Add null stub
   `app/(authenticated)/atlas/page.tsx`.

5. Handle `/oracle/atlas` redirect (§7.5, chosen build order).

6. Write `GrandAtlasPaneBody.test.tsx`:
   - Layer toggle: clicking CORPUS when on → corpus stars disappear from draw calls; clicking
     again restores them (mock `drawStars` call count).
   - Corpus star click → `requestOpenInAppPane` called with `/media/${media_id}`.
   - Readings layer star click → `usePaneRouter().push` called with `/oracle/${folio.id}`.
   - Nebula: star with `x:null` renders at rim altitude (assert `setHoveredId` receives the star).
   - Contradicts edge: `drawEdges` receives an edge with `kind:'contradicts'` and the canvas
     gets a non-gold color (verify via spy on `ctx.strokeStyle` assignment).
   - `requestOpenInAppPane` is NOT called during canvas drag (moved > 4px threshold).

*Verify:* `bun run typecheck && bun run test:unit && bun run test:browser`; navigate to `/atlas` in the app.

### S4 — Edges layer + Nebula polish + redirect

**Scope:** Edge rendering, constellation label, nebula label, redirect, AC pass.

1. Implement `drawEdges` for synapse context (barely-visible) and contradicts (red-gold via CSS variable read at mount). Constellation label at centroid (IM Fell italic small-caps via canvas font string `"italic small-caps 10px 'IM Fell English', serif"`). Nebula label at 6 o'clock rim.

2. Wire `?layer=readings` URL param: `const searchParams = usePaneSearchParams()` (exported from
   `lib/panes/paneRuntime.tsx:429`); `readingsHighlighted = searchParams.get("layer") === "readings"`.
   (`usePaneParams` does not exist — use `usePaneSearchParams`.)

3. Acceptance-criteria pass: all AC items verified manually + automated.

*Verify:* full suite: `make test-back-integration && make test-migrations && bun run typecheck && bun run test:unit && bun run test:browser && make check-bundle`.

---

## 12. Acceptance criteria

- **AC-1.** The `/atlas` pane renders without blocking paint of the rest of the workspace. The
  canvas appears (possibly empty) within 100 ms of pane open; stars appear when the API response
  arrives.
- **AC-2.** A library's works cluster as one constellation with its name in IM Fell small-caps
  italic rendered on the canvas beside the constellation's centroid.
- **AC-3.** A `contradicts` edge renders distinguishably from synapse `context` lines: different
  color (warm red-gold vs faint gold) and higher opacity (0.6 vs 0.1).
- **AC-4.** Clicking a corpus star opens the work in a new pane (`requestOpenInAppPane` called);
  the atlas chart is not replaced.
- **AC-5.** Stars are sized by highlight count: a work with ≥ 5 highlights renders at `bright`
  magnitude (core 2.4px, glow 13px); a work with 0 highlights renders at `faint` (core 1.2px,
  glow 6px).
- **AC-6.** Media without embeddings render in the Nebula fringe band (rim altitude ≤
  `HORIZON_RIM_MARGIN`, hash-stable azimuth per media_id).
- **AC-7.** The CORPUS and READINGS layer toggles are `aria-pressed` buttons. Pressing CORPUS
  hides all corpus stars + constellation lines + edges; pressing again restores them.
- **AC-8.** `/oracle/atlas` redirects to `/atlas?layer=readings` (HTTP 307 or Next.js redirect).
- **AC-9.** `oracleAtlas` does not appear in `paneRouteModel.ts` `PaneRouteId` union or in
  `paneRenderRegistry.tsx`.
- **AC-10.** `atlas_project_job` has exactly one entry in `jobs/registry.py`; no other
  file writes to `media_atlas_positions` outside `services/atlas_projection.py` and test fixtures.
- **AC-11.** ETag round-trip: a second `GET /atlas` with the correct `If-None-Match` header
  returns 304 with no body.
- **AC-12.** `atlas` appears in the destination registry and fixed app-navigation
  projection, the nav rail shows an Atlas entry, and its route resolves a non-empty
  section header from `header.destinationId`.
- **AC-13.** When at least one Nebula star is present (star with `x: null`), a faint italic
  "Nebula" label renders at the 6 o'clock rim position on the canvas (`ctx.fillText('Nebula', …)`
  at `altitude = HORIZON_RIM_MARGIN * 0.4`, azimuth `Math.PI * 1.5` ± `Math.PI / 16`).

---

## 13. Negative gates (grep-able)

```bash
# G1: No numpy import in atlas projection service
if rg -n "import numpy" python/nexus/services/atlas_projection.py; then
  echo "FAIL: numpy in atlas projection"; exit 1; fi

# G2: Sole writer of media_atlas_positions (excluding tests and migration)
if rg -rn "media_atlas_positions" python/nexus/ --include="*.py" \
   | rg -v "atlas_projection\.py|test_|migrations/"; then
  echo "FAIL: non-sole writer of media_atlas_positions"; exit 1; fi

# G3: oracleAtlas route id is dead
if rg -n '"oracleAtlas"' \
   apps/web/src/lib/panes/paneRouteModel.ts \
   apps/web/src/lib/panes/paneRenderRegistry.tsx \
   apps/web/src/lib/panes/paneRouteTable.ts; then
  echo "FAIL: oracleAtlas route id survives"; exit 1; fi

# G4: atlas pane is registered in the pane render registry
if ! rg -n '"atlas"' apps/web/src/lib/panes/paneRenderRegistry.tsx; then
  echo "FAIL: atlas not registered"; exit 1; fi

# G5: atlas destination is in DESTINATIONS
if ! rg -n 'id: *"atlas"' apps/web/src/lib/navigation/destinations.ts; then
  echo "FAIL: atlas not in DESTINATIONS"; exit 1; fi

# G6: No router.push('/oracle/...) in GrandAtlasPaneBody (replaced by requestOpenInAppPane / usePaneRouter)
if rg -n 'router\.push.*oracle' \
   "apps/web/src/app/(authenticated)/atlas/GrandAtlasPaneBody.tsx"; then
  echo "FAIL: residual router.push to oracle in grand atlas"; exit 1; fi

# G7: Contradicts edge draws differently (non-synapse color path exists)
if ! rg -n "contradicts" \
   "apps/web/src/app/(authenticated)/atlas/GrandAtlasPaneBody.tsx"; then
  echo "FAIL: contradicts edge not handled"; exit 1; fi

# G8: Allowlist drift guard still passes
uv run pytest python/tests/test_hetzner_env_sync_validation.py -x
```

---

## 14. Test plan

| Layer | Coverage |
|---|---|
| **Unit (`.test.ts`, node)** | `constellationMst.ts` (Prim MST on 3-star triangle returns 2 media ID pairs, minimum total weight); `corpusMagnitude.ts` (0→faint, 4→glimmer, 5→bright); `projection.ts` (existing unit tests pass at new path); `atlas_projection.py` `pca_2d` fixture (3 orthogonal vectors → known 2D projection); `repulse` (overlapping pair → pushed apart, non-overlapping unchanged) |
| **Browser (`.test.tsx`, Chromium)** | `GrandAtlasPaneBody.test.tsx` (§11.S3.6): layer toggles, star click dispatches, Nebula star hit-test, Nebula label (`ctx.fillText` called with `'Nebula'` when at least one Nebula star present — AC-13), contradicts edge color path, drag threshold, `usePaneRouter` for readings click |
| **Guards** | `test_cutover_negative_gates.py`: sole-writer grep for `media_atlas_positions`; `proxy-routes.test.ts` count reflects +2 |
| **BE integration** | `test_atlas.py`: read model shape + ETag + on-demand enqueue + 304; all-Nebula response (user with library entries but no atlas positions → valid ETag + all stars have `x:null`); `test_atlas_projection.py`: full job run with DB fixture (seeded embeddings → positioned rows) |
| **Migration** | `make test-migrations`: `media_atlas_positions` shape + constraints (x/y range CHECK; projection_version ≥ 1); downgrade removes table cleanly |
| **Static** | `cd python && uv run ruff check . && uv run pyright`; `cd apps/web && bun run typecheck && bun run lint` |
| **E2E** | Deferred (house pattern). Manual smoke: open `/atlas`, verify dome renders; click a positioned star; confirm new pane opens for that media; navigate to `/oracle/atlas`, confirm redirect to `/atlas?layer=readings`. |

---

## 15. Files (created / modified / deleted)

### Created

```
migrations/alembic/versions/NNNN_grand_atlas.py
python/nexus/services/atlas_projection.py          (projection substrate; sole writer of media_atlas_positions)
python/nexus/tasks/atlas_project.py               (job task)
python/nexus/api/routes/atlas.py                  (GET /atlas, GET /atlas/status, POST /atlas/project)
python/nexus/schemas/atlas.py
python/tests/test_atlas_projection.py             (unit + integration for projection service)
python/tests/test_atlas.py                        (route integration)
apps/web/src/app/(authenticated)/atlas/page.tsx                    (null stub)
apps/web/src/app/(authenticated)/atlas/GrandAtlasPaneBody.tsx
apps/web/src/app/(authenticated)/atlas/GrandAtlasPaneBody.test.tsx
apps/web/src/app/(authenticated)/atlas/atlas.module.css            (extended, --atlas-* tokens)
apps/web/src/app/(authenticated)/atlas/projection.ts               (moved from oracle path; ZENITH_MARGIN/HORIZON_RIM_MARGIN/ALTITUDE_SPAN exported)
apps/web/src/app/(authenticated)/atlas/projection.test.ts          (moved alongside projection.ts)
apps/web/src/app/(authenticated)/atlas/StarLabel.tsx               (moved + adapted for star tooltip)
apps/web/src/app/(authenticated)/atlas/AtlasConcordancePeerLoader.tsx  (extracted from AtlasPaneBody before deletion)
apps/web/src/app/(authenticated)/atlas/OracleThemeWrapper.tsx      (6-line theme wrapper; primary definition for this spec and oracle-shell-dissolution)
apps/web/src/lib/atlas/constellationMst.ts
apps/web/src/lib/atlas/corpusMagnitude.ts                          (always a separate module; unit-tested)
apps/web/src/app/api/atlas/route.ts                                (BFF GET + POST)
apps/web/src/app/api/atlas/project/route.ts                        (BFF POST for on-demand trigger)
```

### Modified

```
python/nexus/db/models.py                          (MediaAtlasPosition model)
python/nexus/jobs/registry.py                      (atlas_project_job)
python/nexus/config.py                             (atlas_project_schedule_seconds)
python/nexus/api/routes/__init__.py                (register atlas_router)
python/nexus/services/media_intelligence.py        (on-demand enqueue trigger after unit ready)
python/tests/test_migrations.py                    (head assertions for media_atlas_positions)
python/tests/test_hetzner_env_sync_validation.py   (add atlas_project_job to safe list)
deploy/hetzner/sync-env.sh
deploy/env/env-prod-worker.example
.env.example
apps/web/src/lib/panes/paneRouteModel.ts           (add 'atlas' PaneRouteId + PANE_ROUTE_MODELS entry)
apps/web/src/lib/panes/paneRouteTable.ts           (add PANE_ROUTE_META entry with Map icon)
apps/web/src/lib/panes/paneRenderRegistry.tsx      (add PANE_LOADERS['atlas'])
apps/web/src/lib/navigation/destinations.ts        (add atlas destination)
apps/web/src/app/api/proxy-routes.test.ts          (API_ROUTE_COUNT +2)
apps/web/src/app/(oracle)/oracle/OracleLandingPaneBody.tsx  (update atlasLink href to /atlas?layer=readings)
```

```
apps/web/src/app/(oracle)/oracle/atlas/page.tsx            (becomes redirect to /atlas?layer=readings)
```

### Deleted

```
apps/web/src/app/(oracle)/oracle/atlas/AtlasPaneBody.tsx         (oracle-scoped readings-only body, absorbed)
apps/web/src/app/(oracle)/oracle/atlas/AtlasPaneBody.test.tsx
```

Note: `oracleAtlas` was never registered in `paneRouteModel.ts`, `paneRouteTable.ts`, or
`paneRenderRegistry.tsx` (the oracle atlas lived in the `(oracle)` route group). No pane-registry
deletion needed. G3 gate confirms absence.

---

## 16. Risks

**R-1. PCA degeneracy on tiny corpora (HIGH).**
With fewer than 3 media having embeddings, PCA has fewer variance directions than components
requested. *Mitigation:* in `atlas_projection.py`, gate the PCA: `if len(vectors) < 3: use_ring_fallback()`. Ring fallback: evenly space N works around a unit circle, `x = 0.5 + 0.4 * cos(2π * i / N)`, `y = 0.5 + 0.4 * sin(...)`. This produces a stable, non-degenerate layout that the repulsion pass then leaves alone (all distances equal). Unit test: 2-vector input → ring layout.

**R-2. Projection churn — the map feels unstable as works are added (MEDIUM).**
D-4 gates position updates to full projection_version bumps (nightly batch). However, if the
nightly job always produces meaningfully different 2D coordinates (PCA is not rotation-invariant
between runs), the topology changes every night. *Mitigation:* (a) the PCA sign is fixed by
choosing the deterministic eigenvector initialization (§D-2 seed vector); (b) min-max
normalization makes the output range stable. (c) Consider recording `projection_version` on the
pane URL as a cache key so the user sees a consistent map within a session.

**R-3. pgvector `avg()` unavailable in dev environment (LOW).**
If a developer runs a vanilla PostgreSQL image without pgvector, the SQL query fails. *Mitigation:*
`atlas_projection.py` catches `ProgrammingError` with `function avg(vector)` in the message and
falls back to Python averaging via individual row fetch. A warning is logged. Unit tests use
fixture vectors and never touch pgvector avg.

**R-4. Canvas performance on large corpora (MEDIUM).**
For N ≥ 2000 stars, `drawStars` iterates all stars per frame (~60 fps). At N=2000, 60 fps × 2000 =
120k draw-calls/s — acceptable on desktop, marginal on mobile. *Mitigation:* rAF runs only during
interaction (drag/hover); idle drift can be throttled to 10 fps when `!interactingRef.current`
(reduce idle RAF to `setTimeout(requestAnimationFrame, 100)` pattern). The existing
`reducedMotionRef` stops idle rotation entirely under prefers-reduced-motion.

**R-5. `oracleAtlas` route id inadvertently added by a future spec (LOW).**
oracle-shell-dissolution is built after this spec; if that spec (or another) adds `oracleAtlas`
to the pane files, the G3 negative gate (`rg '"oracleAtlas"'`) will fail loudly. The cross-spec
claim in §10 declares `oracleAtlas` must never be created. No action required at build time of
this spec.

**R-6. Concurrent agent modifies pane registration files (LOW).**
Per repo memory, a concurrent agent shares the checkout. The modified files in §15 include
`paneRouteModel.ts`, `destinations.ts`, and `paneRenderRegistry.tsx` — all touched by sibling
specs. *Mitigation:* stage explicitly, never `git add -A`; coordinate file-level ownership in the
build agent's planning pass.
