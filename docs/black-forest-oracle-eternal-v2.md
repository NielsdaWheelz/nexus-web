# Black Forest Oracle — Eternal, Volume II (Hard Cutover)

Builds on `docs/black-forest-oracle-eternal.md` (v1, already shipped). v1's
tripartite arc, illuminated capital, border frame, fleurons, and colophon
remain. v2 turns the oracle from a single ritual into *a book that grows*: a
folio carries a maxim and a theme; passages are presented as *openings* in
named works; the library shows itself in an Aleph and remembers itself in a
Concordance; the interpretation speaks in first-person visionary register.

No legacy code, no fallbacks, no backwards compatibility. Schema changes
ship as a **new migration `0076_oracle_eternal_v2.py`** because v1 has
been pushed to production. Existing v1 folios are preserved with their
`folio_title` backfilled into `folio_motto`; `folio_theme` stays NULL on
v1 rows. New v2 readings always set both.

## Target Behaviour

### Asking, end to end

1. User opens `/oracle`. The form sits at the top. Below it, **the Aleph**:
   a grid of every folio they have ever cast — each cell a plate thumbnail
   with the Roman folio number and the motto. The book shows itself.
2. User asks a question. The same lifecycle as v1: POST creates a folio,
   the worker calls Anthropic, SSE streams the reading.
3. The LLM now produces, in addition to v1's argument and interpretation:
   - a **motto** (Latin maxim, ~2–6 words; English allowed if no clean
     Latin paraphrase)
   - a **gloss** (English translation, only if the motto is not English)
   - a **theme** picked from a fixed list of 24 traditional headings
4. As events arrive, the reading page renders top to bottom:
   - Folio header — `Folio XII · Of Courage` / `AVDENTES FORTVNA IVVAT` /
     *Fortune favors the bold.*
   - Question, argument, plate, three passage blocks, interpretation,
     omens, **Concordance**, colophon.
5. Each passage block shows the **opening line** as its header:
   *Virgil opened to* Aeneid *X.467* — author, italic title, locator.
6. The interpretation reads in **first-person visionary register**: *I
   saw a road bending into shadow…* The closing turn addresses the
   seeker as *you*.
7. Below omens, the **Concordance** lists up to 5 prior folios that echo
   this one — same plate, same theme, or shared passage. Each link is a
   one-line `Folio VII · Of Time · The Solitary Lamp` with a small kicker
   naming the share reason. If there are no echoes, the section is
   omitted entirely.
8. Returning to `/oracle` shows the Aleph now containing the new folio.

### Reload mid-stream

Same as v1: SSE replay from the persisted event log restores motto,
gloss, theme, plate, passages, interpretation tokens, omens, and `done`.
The Concordance is fetched lazily when the reading reaches `complete`.

## Structure

### What's added (delta over v1)

| Concern | v1 | v2 |
|--|--|--|
| Folio identity | `folio_title` (Text NULL, 2–4 words) | `folio_motto` (Text NOT NULL, ≤80 chars) + `folio_motto_gloss` (Text NULL, ≤120 chars) |
| Folio classification | none | `folio_theme` (Text NOT NULL, one of 24) |
| Passage attribution | "Author, *Title*. Edition." | "Author opened to *Title* Locator." |
| Interpretation voice | third-person commentary | first-person visionary |
| Library landing | recent-5 list | Aleph grid (all folios) |
| Cross-references | none | Concordance section on detail page |

### What stays

- Three phases (descent, ordeal, ascent) — exactly three passages, each
  a distinct phase. Locked from v1.
- Citation integrity contract: LLM picks indices and writes marginalia;
  visible quote / locator / attribution flow from the corpus row.
- Single LLM call per reading; service unpacks fields into separate
  events for the stream.
- Folio-number allocation: server-side `MAX + 1`, retried on UNIQUE
  conflict. Failed readings still consume their folio number.
- IlluminatedCapital, BorderFrame, fleurons, colophon — unchanged.

## Architecture

### Schema (new migration `0076_oracle_eternal_v2.py`)

`oracle_readings` — additive + drop, with backfill:

```
ADD COLUMN folio_motto TEXT NULL;
ADD COLUMN folio_motto_gloss TEXT NULL;
ADD COLUMN folio_theme TEXT NULL;

UPDATE oracle_readings SET folio_motto = folio_title
WHERE folio_title IS NOT NULL;

ALTER TABLE oracle_readings DROP COLUMN folio_title;

ADD CONSTRAINT ck_oracle_readings_motto_length CHECK (
  folio_motto IS NULL OR char_length(folio_motto) BETWEEN 1 AND 80
);
ADD CONSTRAINT ck_oracle_readings_motto_gloss_length CHECK (
  folio_motto_gloss IS NULL OR char_length(folio_motto_gloss) BETWEEN 1 AND 120
);
ADD CONSTRAINT ck_oracle_readings_theme CHECK (
  folio_theme IS NULL OR folio_theme IN (
    'Of Time','Of Death','Of the Threshold','Of Vanity','Of Solitude','Of Love',
    'Of Fortune','Of Memory','Of the Self','Of the Other','Of Fear','Of Courage',
    'Of Faith','Of Doubt','Of Power','Of Wisdom','Of the Body','Of the Soul',
    'Of Origins','Of Endings','Of Silence','Of the Word','Of Justice','Of Mercy'
  )
);
```

The columns are **nullable in DB** (motto is NULL during streaming and on
v1 backfilled rows; theme is NULL during streaming and on v1 rows).
Forward: the service enforces non-NULL motto + theme on every newly
completed reading. v1 rows keep their motto (promoted from folio_title)
and have NULL theme.

`downgrade()` re-adds `folio_title` (NULL), copies motto back into it,
drops the three new columns and constraints. Symmetric.

Indexes for the Concordance query (per-user lookups by plate / theme):

```
CREATE INDEX idx_oracle_readings_user_image  ON oracle_readings (user_id, image_id);
CREATE INDEX idx_oracle_readings_user_theme  ON oracle_readings (user_id, folio_theme);
```

`oracle_reading_passages`: unchanged. Its `source_ref->>'citation_key'`
is what the Concordance compares for shared-passage matches; the JSONB
GIN index already exists on `source_ref` (verify; if absent, add
`CREATE INDEX idx_oracle_reading_passages_citation_key ON
oracle_reading_passages ((source_ref->>'citation_key'));`).

`oracle_reading_events` CHECK: unchanged. The `bind` payload shape
changes (motto + gloss + theme replaces folio_title), but no new event
type is needed.

### Service (`python/nexus/services/oracle.py`)

**Constants.**

```python
ORACLE_PROMPT_VERSION = "oracle-v3"
ORACLE_THEMES: tuple[str, ...] = (
    "Of Time", "Of Death", "Of the Threshold", "Of Vanity",
    "Of Solitude", "Of Love", "Of Fortune", "Of Memory",
    "Of the Self", "Of the Other", "Of Fear", "Of Courage",
    "Of Faith", "Of Doubt", "Of Power", "Of Wisdom",
    "Of the Body", "Of the Soul", "Of Origins", "Of Endings",
    "Of Silence", "Of the Word", "Of Justice", "Of Mercy",
)  # 24 entries; mirrors the DB CHECK
```

**Prompt v3 changes.** Rule 8 (folio_title) is replaced by:

> 8. Compose ONE folio motto: a Latin maxim of two to six words (e.g.
> *Audentes Fortuna Iuvat*, *Memento Mori*, *Nosce Te Ipsum*), ideally
> a canonical sententia or a clear paraphrase of one. If no Latin
> phrasing fits, an English maxim is allowed. The motto is imperative
> or declarative, never a name.
>
> 8b. Compose a gloss: a single English sentence (≤120 chars)
> translating or paraphrasing the motto, *only* if the motto is not in
> English. If the motto is English, the gloss is null.
>
> 8c. Pick ONE folio theme from this exact list: <24 themes>. The theme
> classifies what this reading is *about*. Match by primary subject,
> not by mood.

Rule 9 (interpretation voice) is rewritten:

> 9. Compose one continuous interpretation of three to five paragraphs
> in **first-person visionary register**: *I saw…*, *I heard…*, *I
> stood at…*. The voice belongs to the oracle as witness. Use *you*
> sparingly and only in the closing turn, addressing the seeker. No
> hedging ("perhaps", "may", "might"). Declarative, brief, certain.

Rule 11 (output JSON) shape:

```json
{
  "argument": "Of …",
  "folio_motto": "Audentes Fortuna Iuvat",
  "folio_motto_gloss": "Fortune favors the bold.",
  "folio_theme": "Of Courage",
  "passages": [
    {"phase": "descent", "candidate_index": 4, "marginalia": "..."},
    {"phase": "ordeal",  "candidate_index": 0, "marginalia": "..."},
    {"phase": "ascent",  "candidate_index": 7, "marginalia": "..."}
  ],
  "interpretation": "I saw …",
  "omens": ["...", "...", "..."]
}
```

**Parser.** `_parse_llm_output` returns
`tuple[str, str, str | None, str, dict[str, tuple[int, str]], str, list[str]] | None`
— `(argument, folio_motto, folio_motto_gloss, folio_theme, by_phase,
interpretation, omens)`. Validates: motto length 1–80, gloss length
1–120 or null, theme membership in `ORACLE_THEMES`, three distinct
phases, three distinct candidate indices, omens length 3.

**Sortes attribution.** In `_retrieve_corpus_passages`, change the
attribution composition:

```python
attribution_text = f"{row['work_author']} opened to *{row['work_title']}* {row['locator_label']}."
```

(Drops `edition_label` from the visible line; the edition still lives in
`source_ref.source.edition_label` for provenance.) `_candidate_from_content_chunk_row`
keeps user-library attribution unchanged (`From *{media_title}*, your library.`).

**Execute reading.** `bind` event payload changes:

```python
_append_event(db, reading_id, "bind", {
    "folio_motto": folio_motto,
    "folio_motto_gloss": folio_motto_gloss,
    "folio_theme": folio_theme,
})
```

Persists `reading.folio_motto = folio_motto`, `reading.folio_motto_gloss = folio_motto_gloss`,
`reading.folio_theme = folio_theme` before emitting bind.

**`compute_concordance`.** New function on the service module:

```python
def compute_concordance(
    db: Session,
    *,
    viewer_id: UUID,
    reading_id: UUID,
) -> list[ConcordanceEntryOut]:
```

Loads the reference reading (image_id, folio_theme, set of passage
citation_keys). Runs one query against `oracle_readings` joined with
`oracle_reading_passages`, filtered to the same user, status = complete,
id != reference. For each candidate folio computes:

- `shared_plate: bool` — same `image_id`
- `shared_theme: bool` — same `folio_theme`
- `shared_passage_keys: list[str]` — citation_keys present in both

Score = `2 * shared_plate + 2 * shared_theme + len(shared_passage_keys)`.
Filters to score > 0, orders by score desc then created_at desc, takes
top 5. Returns `ConcordanceEntryOut` per row.

### API (`python/nexus/api/routes/oracle.py`)

**Modified endpoints:**

- `GET /api/oracle/readings` — returns *all* of the viewer's readings (no
  limit). Each summary now carries motto, gloss, theme, and (for
  completed readings) plate thumbnail URL + plate alt text. Pending and
  failed folios are included with null plate.

**New endpoints:**

- `GET /api/oracle/readings/{reading_id}/concordance` — returns up to 5
  related folios. 200 with empty list if no echoes; 404 if the reading
  is not the viewer's. The endpoint requires the reading to be
  `complete`; returns 409 (or empty) if pending.

`POST /api/oracle/readings` is unchanged.

### Schemas (`python/nexus/schemas/oracle.py`)

```python
class OracleReadingSummaryOut(BaseModel):
    id: UUID
    folio_number: int
    folio_motto: str | None        # null while pending
    folio_motto_gloss: str | None
    folio_theme: str | None        # null while pending
    plate_thumbnail_url: str | None
    plate_alt_text: str | None
    question_text: str
    status: str
    created_at: datetime
    completed_at: datetime | None = None
    failed_at: datetime | None = None
    model_config = ConfigDict(from_attributes=True)

class OracleReadingDetailOut(BaseModel):
    # ... existing fields ...
    folio_motto: str | None
    folio_motto_gloss: str | None
    folio_theme: str | None
    # remove: folio_title

class ConcordanceEntryOut(BaseModel):
    id: UUID
    folio_number: int
    folio_motto: str
    folio_theme: str
    shared_plate: bool
    shared_theme: bool
    shared_passage_count: int
```

(motto/gloss/theme are nullable on `Detail`/`Summary` only because a
pending reading has not yet bound them; once `status = complete` they
are guaranteed non-null. The DB columns themselves are NOT NULL on
inserted-completed rows — pending rows are inserted with placeholder
empty strings, which the bind step replaces. *Or:* allow NULL in DB and
flip after bind. **Decision: allow NULL in DB during streaming, flip on
bind.** See Key Decisions §3.)

### Frontend

**New component — `OracleAlephGrid.tsx` (~80 LOC).**
- Fetches `/api/oracle/readings` on mount.
- Renders a CSS grid (`grid-template-columns: repeat(auto-fill, minmax(140px, 1fr))`).
- Each cell: square plate thumbnail (object-fit: cover), Roman folio
  number overlaid bottom-left, motto on top in two-line clamp.
- Pending folios render with a candle-flame placeholder + ellipsis.
- Failed folios are dimmed and unclickable.
- Clicking a cell navigates via `paneRuntime.router.push`.

**New component — `OracleConcordance.tsx` (~50 LOC).**
- Fetches `/api/oracle/readings/{readingId}/concordance` once on mount,
  but only when the parent reports `status === "complete"`.
- Renders `null` if the response is empty.
- Otherwise: `<aside className={styles.concordance}>` with a heading
  *Concordance*, then one row per echo:
  ```
  Folio VII · Of Time · Solvitur Ambulando
  shared plate · shared theme
  ```
  Click → navigates to that folio.

**Modified — `OracleLandingPaneBody.tsx`.** The recent-readings list is
deleted. `<OracleAlephGrid />` replaces it. The form, epigraph, and
error states stay.

**Modified — `OracleReadingPaneBody.tsx`.**
- Folio header replaces v1's `Folio XII · The Solitary Lamp`:

  ```tsx
  <header className={styles.foliumHeader}>
    <span className={styles.foliumNumber}>Folio {toRoman(folioNumber)}</span>
    <span className={styles.foliumDot}>·</span>
    <span className={styles.foliumTheme}>{folioTheme ?? "……"}</span>
    {folioMotto !== null && (
      <>
        <div className={styles.foliumMotto}>{folioMotto}</div>
        {folioMottoGloss !== null && (
          <div className={styles.foliumGloss}>{folioMottoGloss}</div>
        )}
      </>
    )}
  </header>
  ```

- `applyEvent` for `bind` now reads
  `payload.folio_motto`, `payload.folio_motto_gloss`, `payload.folio_theme`
  and sets state. The local interface drops `folioTitle` entirely.
- Passage block header now renders `attribution_text` as the prominent
  opening line (no extra structural change — backend already formats
  the sortes line). Phase label stays as the small kicker above.
- Below the omens block, before the colophon: `<OracleConcordance
  readingId={readingId} status={status} />`.

**Modified — `oracle.module.css`.**
- New: `.alephGrid`, `.alephCell`, `.alephThumbnail`, `.alephCellNumber`,
  `.alephCellMotto`, `.alephCellPending`, `.alephCellFailed`.
- New: `.foliumMotto` (display caps, gold, EB Garamond, letter-spacing
  +0.06em), `.foliumGloss` (italic, smaller, secondary text color),
  `.foliumTheme` (kicker; replaces fraktur title slot).
- New: `.concordance`, `.concordanceItem`, `.concordanceShareReason`.
- Remove: `.foliumTitle`, `.foliumTitlePending` (folio_title is gone),
  `.recentList`, `.recentItem`, `.recentMain`, `.recentFolio*`,
  `.recentQuestionLine`, `.recentStatus` (recent list deleted).
- The IlluminatedCapital, BorderFrame, fleurons, colophon styles are
  unchanged.

## Final State

A reading page renders:

```
┌─ BorderFrame ────────────────────────────────────────────────────┐
│                                                                  │
│              Folio XII · Of Courage                              │
│              AVDENTES FORTVNA IVVAT                              │
│                Fortune favors the bold.                          │
│                                                                  │
│           "What lies on the other side of this threshold?"       │
│                                                                  │
│   Of the longing for unbroken light, and the lamp the soul       │
│       keeps lit when the wood grows close.                       │
│                                                                  │
│                       [ ENGRAVED PLATE ]                         │
│                                                                  │
│                        ❦   ❦   ❦                                │
│                                                                  │
│   I. The Descent                                                 │
│   Virgil opened to Aeneid X.467.                                 │
│   "…"                                                            │
│   marginalia: …                                                  │
│                                                                  │
│   II. The Ordeal                                                 │
│   Dante opened to Inferno III.9.                                 │
│   "…"                                                            │
│                                                                  │
│   III. The Ascent                                                │
│   Hopkins opened to The Wreck of the Deutschland XXXV.           │
│   "…"                                                            │
│                                                                  │
│                        ❦   ❦   ❦                                │
│                                                                  │
│   ┃Ⓘ saw a road bending into shadow, and the lamp's small        │
│   ┃flame thrown forward like a question. I heard the trees…     │
│   …                                                              │
│   You stand at the threshold; the dark woods read you back.      │
│                                                                  │
│                        ❦   ❦   ❦                                │
│                                                                  │
│   Omens                                                          │
│   ❦ a candle held against the night                              │
│   ❦ the road that does not promise                               │
│   ❦ the wood as both shelter and snare                           │
│                                                                  │
│                        ❦   ❦   ❦                                │
│                                                                  │
│   Concordance                                                    │
│   Folio VII · Of Solitude · Memento Mori                         │
│       shared plate · shared theme                                │
│   Folio III · Of the Threshold · Solvitur Ambulando              │
│       shared passage                                             │
│                                                                  │
│                        ❦   ❦   ❦                                │
│                                                                  │
│   Composed for N. on the fifth of May, MMXXVI.                   │
│   Plate after Doré.                                              │
│   Set in EB Garamond, IM Fell English, and UnifrakturMaguntia.   │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

A landing page renders:

```
┌─ BorderFrame ────────────────────────────────────────────────────┐
│                                                                  │
│              Black Forest Oracle                                 │
│   Ask one question. The oracle will arrange a plate, three       │
│   passages, and a reading drawn from public-domain literature    │
│   and your library.                                              │
│                                                                  │
│   ┌──────────────── question textarea ────────────────────┐      │
│   │                                                       │      │
│   └───────────────────────────────────────────────────────┘      │
│                                          [ Consult the oracle ]  │
│                                                                  │
│   ─────────────────────  The Aleph  ──────────────────────       │
│                                                                  │
│   ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐               │
│   │ 🜔 │ │ 🜍 │ │ 🜎 │ │ 🜏 │ │ 🜐 │ │ 🜑 │ │ 🜒 │               │
│   │ XII │ │ XI │ │ X  │ │ IX │ │VIII│ │VII │ │ VI │               │
│   │AUDE.│ │MEME│ │NOSC│ │ARS │ │CARP│ │SOLV│ │AMOR│               │
│   └────┘ └────┘ └────┘ └────┘ └────┘ └────┘ └────┘               │
│   …                                                              │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

## Rules

1. **Motto and theme are required on every newly completed v2 folio.**
   Streaming starts with motto/gloss/theme = NULL; the `bind` event sets
   motto + gloss + theme; the service refuses to flip a reading to
   `complete` without a non-NULL motto and theme. v1 backfilled rows
   are an exception: they keep the motto promoted from the old title
   and have NULL theme. The frontend renders the missing theme as a
   blank kicker; concordance never matches NULL theme to NULL theme.
2. **Motto language.** Latin preferred. English allowed when no clean
   Latin paraphrase exists. Gloss is required iff motto is not English;
   gloss is null iff motto is English. (LLM-judged; the prompt is
   explicit.)
3. **Theme is one of 24.** Hard-coded constant in
   `services/oracle.py::ORACLE_THEMES`, mirrored in DB CHECK constraint,
   listed in the system prompt. LLM picks one; parser rejects anything
   else. Adding or removing a theme is a migration + constant edit.
4. **Theme classifies subject, not mood.** Two readings about courage
   share `Of Courage` even if one is fearful and one defiant. (LLM
   guidance only; not enforced.)
5. **Passage attribution is sortes-formatted for public-domain
   sources.** `attribution_text = "{author} opened to *{title}*
   {locator_label}."` Edition label is dropped from the visible line and
   retained in source_ref for provenance.
6. **User-library passages keep their attribution.** No "opened to"
   framing for `source_kind = user_media`.
7. **Voice contract.** Interpretation in first-person visionary
   register. Enforced in the system prompt; no automated validator.
8. **Concordance is computed at read time.** No materialized view, no
   cache, no concordance table. One SQL per detail load. Indexed on
   `(user_id, image_id)` and `(user_id, folio_theme)`; passage joins
   use `source_ref->>'citation_key'`.
9. **Concordance is per-user.** Folios link only to the same user's
   other folios.
10. **Concordance is empty-or-up-to-five.** No pagination, no "see
    more". If empty, the section is omitted entirely.
11. **Aleph shows all folios.** No pagination, no virtualization.
    Practical cap: ~200 folios per user. Past that we revisit.
12. **Aleph shows pending and failed folios honestly.** Pending = candle
    placeholder + ellipsis motto. Failed = dimmed, unclickable, with the
    folio number visible. The codex tells the truth.
13. **Hard cutover.** New migration 0076 drops `folio_title` after
    backfilling its content into `folio_motto`. No rename, no view, no
    shim. v1's bind event payload (`{folio_title}`) is replaced
    (`{folio_motto, folio_motto_gloss, folio_theme}`); the in-repo
    frontend ships the new shape together with the backend.

## Goals

1. Compress folio identity to a *maxim*, not a name. The motto tells
   the reader where to stand.
2. Index folios by tradition. 24 themes give the codex a thematic spine
   alongside its chronological one.
3. Frame the oracle's curation as bibliomancy. *Virgil opened to Aeneid
   X.467.* The work becomes the patron, the line becomes a found gift.
4. Make the library self-aware. Folios that echo each other show their
   echoes — same plate, same theme, shared passage.
5. Make the library visible. The Aleph is the codex laid open: every
   folio at once, finite, complete, browsable.
6. Speak in a credentialed visionary voice. *I saw* is Hildegard's
   voice, Blake's voice, the voice of someone who has actually seen.
7. Preserve every v1 contract. Citation integrity, three-phase arc,
   illuminated capital, fleurons, colophon, border, BorderFrame.

## Acceptance Criteria

### Backend

- Migration 0076 applies cleanly to a DB with v1 data: oracle_readings
  has motto / gloss / theme columns; existing rows have `folio_motto`
  populated from the old `folio_title`; `folio_title` column is gone;
  theme CHECK constraint rejects non-list values; downgrade restores
  `folio_title` symmetrically.
- `POST /oracle/readings` returns folio_number (unchanged).
- `GET /oracle/readings` returns *all* folios for the viewer with
  motto / gloss / theme / plate_thumbnail_url. Recent-only behavior is
  removed.
- `GET /oracle/readings/{id}` returns motto / gloss / theme; folio_title
  is absent from the response.
- `GET /oracle/readings/{id}/concordance` returns ≤5 entries when the
  reading is complete; empty list when no echoes; 404 when the reading
  is not the viewer's.
- SSE `bind` event payload is `{folio_motto, folio_motto_gloss,
  folio_theme}`; the `argument` event is unchanged.
- Passage `attribution_text` for public-domain sources is sortes-
  formatted (`"{author} opened to *{title}* {locator}."`); user-library
  attribution is unchanged.
- LLM smoke test: five varied questions yield well-formed motto /
  gloss / theme; theme always within the 24-list; interpretations open
  with first-person constructions.
- Pyright clean. Ruff clean.

### Frontend

- `/oracle` shows the Aleph grid below the question form. Cells render
  thumbnail + Roman folio + motto. Click navigates. Pending folios
  show candle placeholder; failed folios are dimmed.
- Reading view folio header renders Roman folio number, theme kicker,
  display-caps motto, italic gloss (when motto is not English).
- Each passage block's header is the sortes attribution line (`{author}
  opened to *{title}* {locator}.`). Phase label remains as the small
  kicker above.
- Interpretation reads in first-person register (manual smoke check on
  five questions; voice consistently uses *I saw / I heard / I stood*).
- Concordance section appears below omens, above colophon, when the
  reading has ≥1 echo. Each entry shows folio number, theme, motto,
  and the share reason(s). Empty concordance → section omitted.
- IlluminatedCapital, BorderFrame, fleurons, colophon — all unchanged
  visually.
- TSC clean. ESLint clean. No inline lint disables.

### Citation integrity (carried forward, restated)

- Visible quote / locator / attribution text on every passage flow
  from corpus rows. The LLM contributes only `marginalia`, `argument`,
  `folio_motto`, `folio_motto_gloss`, `folio_theme`, `interpretation`,
  `omens`. (Verified by inspecting the persisted event payloads.)

## Non-Goals

- No multi-user concordance. Folios link only to the same user's
  folios. Cross-user echoes would require anonymization, moderation,
  and a different UX. Out of scope.
- No pagination / virtualization for the Aleph. Past ~200 folios per
  user we'll revisit; not now.
- No retroactive theme for v1 folios. The migration backfills
  `folio_motto` from `folio_title` (lossless promotion) but leaves
  `folio_theme` NULL on v1 rows. Backfilling a synthetic theme would
  over-link old folios in the Concordance.
- No music, no antiphon, no viriditas color shift. (Considered;
  shelved for a later round.)
- No self-quotation in interpretations ("As Folio VII observed…").
  LLM hallucination risk too high without grounded retrieval; not
  worth the citation-integrity exposure for v2.
- No Concordance materialization, no Concordance table. Computed at
  read time.
- No Concordance over failed folios. Only `status = complete` is
  considered as either reference or candidate.
- No edition_label in the visible attribution. Sortes attribution is
  author + title + locator. Edition stays in `source_ref.source` for
  provenance only.
- No backwards-compatible payload for the `bind` event. v1 consumers
  will break; we ship frontend and backend together.
- No new SSE event types. Theme + motto + gloss ride on `bind`. The
  Concordance is a separate REST call after `done`, not an SSE event.

## Files

### Backend (5 modified, 0 new)

- `migrations/alembic/versions/0076_oracle_eternal_v2.py` — NEW
  migration. Add folio_motto / folio_motto_gloss / folio_theme as
  nullable; backfill folio_motto from folio_title for existing rows;
  drop folio_title; add length + theme CHECK constraints; add two
  indexes for concordance lookups; symmetric downgrade.
- `python/nexus/db/models.py` — `OracleReading`: drop folio_title;
  add motto, gloss, theme Mapped columns; CheckConstraint for theme.
- `python/nexus/schemas/oracle.py` — drop folio_title from
  `OracleReadingDetailOut` / `OracleReadingSummaryOut`; add motto /
  gloss / theme; add `plate_thumbnail_url` + `plate_alt_text` to summary;
  new `ConcordanceEntryOut`.
- `python/nexus/services/oracle.py` — `ORACLE_PROMPT_VERSION = "oracle-v3"`;
  `ORACLE_THEMES` constant; system prompt v3 (motto / theme / first-person
  voice); `_parse_llm_output` returns the new tuple; `execute_reading`
  emits new `bind` shape and persists motto/gloss/theme; sortes
  `attribution_text` in `_retrieve_corpus_passages`; `list_recent_readings`
  → `list_all_readings` (returns all folios with thumbnail URLs);
  new `compute_concordance`; remove `ORACLE_RECENT_READINGS_LIMIT`.
- `python/nexus/api/routes/oracle.py` — list endpoint returns all;
  new concordance endpoint.
- (Tests, where they exist:) update fixtures to feed motto/theme;
  add tests for theme validation, concordance ordering, sortes
  attribution.

### Frontend (3 modified, 2 new)

- `apps/web/src/app/(authenticated)/oracle/OracleAlephGrid.tsx` — NEW.
- `apps/web/src/app/(authenticated)/oracle/OracleConcordance.tsx` — NEW.
- `apps/web/src/app/(authenticated)/oracle/OracleLandingPaneBody.tsx`
  — replace recent list with `<OracleAlephGrid />`; remove inline
  toRoman (now lives in `OracleAlephGrid` and `OracleReadingPaneBody`,
  duplicated; the duplication is accepted).
- `apps/web/src/app/(authenticated)/oracle/[readingId]/OracleReadingPaneBody.tsx`
  — folio header (number + theme + motto + gloss); drop `folioTitle`
  state and event handler; passage opening line is the existing
  `attribution_text` (no JSX change here, the wire format does the
  work); add `<OracleConcordance />` below omens.
- `apps/web/src/app/(authenticated)/oracle/oracle.module.css` — Aleph
  grid styles; foliumMotto / foliumGloss / foliumTheme; concordance
  styles; remove foliumTitle, foliumTitlePending, recent-list styles.

### Docs

- `docs/black-forest-oracle-eternal-v2.md` — this spec.

## Key Decisions

1. **Motto and gloss as separate columns.** One column with delimited
   `"motto || gloss"` would couple them; two columns let the gloss be
   genuinely null when the motto is English. The frontend treats the
   absence of a gloss as "motto is English; render no second line."

2. **Theme as a hard-coded enum, not a free-text field.** Free-text
   would yield "Of Time" / "On Time" / "Time" duplicates that defeat
   cross-indexing. 24 is enough breadth for a literary codex without
   diluting (cf. 24 hours, 24 books of the Iliad). The list lives in
   one constant; changing it is a migration.

3. **Motto / gloss / theme columns are nullable in DB.** Three reasons:
   (a) the row is inserted at `pending` before the LLM has run; (b) v1
   rows backfilled from `folio_title` keep NULL theme; (c) NOT NULL
   would force placeholder writes that lie about row state. The service
   path that flips a v2 reading to `complete` asserts non-NULL motto +
   theme. Pydantic marks the fields `str | None`; the frontend renders
   pending or v1 rows with a blank kicker.

4. **Sortes attribution is a string change, not a wire-format change.**
   The frontend already renders `attribution_text`; backend just
   composes a different string. This keeps the v2 client lean — no
   structured `{author, work, locator}` object to consume. The
   structured fields stay in `source_ref` for anyone who wants to
   parse them.

5. **Concordance is REST, not SSE.** Computed lazily on detail load,
   not pushed via the stream. The reading is "done" when the LLM
   work is done; the Concordance is a *view of the library*, not part
   of the reading itself. Decoupling avoids one more event type and
   one more cursor-replay edge case.

6. **Concordance score = 2·plate + 2·theme + N·passages.** Plate match
   is most distinctive (image_id is a sharp signal); theme match is
   intentional but coarser; passage match is the strongest semantic
   signal *per match*. The `2·` weights make a single plate or theme
   match equivalent to two passage matches; a folio with both a plate
   match and a passage match outranks a folio with just one of either.
   Tunable; this is the v2 starting point.

7. **Aleph replaces recent list — not "added alongside."** The recent
   list dies. v1 had it as a literal recent-5 sidebar; v2's library *is*
   the list. Two views of the same thing would be redundant.

8. **`list_recent_readings` is renamed `list_all_readings`** and loses
   its `LIMIT 5`. The endpoint URL is unchanged. v1 callers that
   expected ≤5 will get more; the frontend caller handles all sizes.

9. **First-person voice is prompt-only, not validated.** Adding a
   server-side check ("must contain 'I saw' in first sentence") would
   be brittle and rejection-loop the LLM on benign variations. The
   prompt explicitly demands the register; if outputs slip we tune the
   prompt, not add a regex.

10. **Pending and failed folios visible in the Aleph.** A grid of only
    completed folios would hide the user's recent ask and silently
    swallow failures. Show them: pending = candle + ellipsis, failed =
    dimmed. The codex is honest.

11. **No new fonts.** Display caps for the motto are EB Garamond with
    `font-feature-settings: "smcp"; letter-spacing: +0.06em;
    text-transform: uppercase`. No new family loaded.

12. **One concordance section, max five entries, no expand.** Five is
    enough to feel meaningful and not enough to clutter. Past five
    we'd be inviting a longer view; out of scope.

## Cutover Plan

1. **Schema.** Create `0076_oracle_eternal_v2.py`: add motto / gloss /
   theme as nullable, backfill motto from folio_title, drop folio_title,
   add CHECKs + indexes. Mirror in `db/models.py`. Run `make db-upgrade`
   on a fresh DB seeded with v1 data to verify backfill.
2. **Service.** Add `ORACLE_THEMES`. Update system prompt v3 (motto,
   theme, voice). Update `_parse_llm_output`. Update `execute_reading`
   bind payload. Add `compute_concordance`. Update
   `_retrieve_corpus_passages` attribution. Rename + extend
   `list_all_readings`.
3. **API.** Update list endpoint (no more LIMIT, includes thumbnail
   fields). Add concordance endpoint.
4. **Schemas.** Update `OracleReadingSummaryOut`,
   `OracleReadingDetailOut`. Add `ConcordanceEntryOut`.
5. **Backend tests.** Update parser test fixtures. Add concordance
   ordering test. Add theme validation test. Add sortes attribution
   assertion.
6. **Frontend.** Build `OracleAlephGrid.tsx`, `OracleConcordance.tsx`.
   Update `OracleLandingPaneBody.tsx` to swap in the grid. Update
   `OracleReadingPaneBody.tsx` for motto / gloss / theme header,
   concordance section.
7. **CSS.** Add new classes; remove the old recent-list and folio_title
   classes.
8. **Lint + type + build + test.**
9. **Manual sanity.** Reset DB, seed corpus, run three readings on
   varied questions. Verify motto register, theme labels, sortes
   attribution, voice register, Aleph grid, Concordance after the
   third reading echoes the first two.

## Risks

1. **Latin motto reliability.** Anthropic Haiku may produce shaky
   Latin or fall back to English too eagerly. Mitigation: prompt
   includes a small canonical-sententia palette; English fallback is
   explicit. Tune as needed.
2. **24 themes too narrow / too coarse.** A user's question may not
   fit any heading cleanly. Mitigation: easy revision later (constant
   edit + migration). Start tight; widen if it pinches.
3. **First-person voice slips.** The LLM may revert to third-person
   commentary under load. Mitigation: prompt with explicit examples;
   monitor the first ~20 readings; tighten if needed.
4. **Concordance score weighting wrong on small libraries.** With 3
   folios, every echo looks meaningful. Mitigation: 5-cap, hide when
   empty. Real signal emerges past ~10 folios.
5. **Aleph grid layout on small screens.** 140px minimum may be too
   wide for narrow phones. Mitigation: a `min-width: 100px` breakpoint
   below 480px viewport; verify in browser.
6. **Pending folio in Aleph competes with the question form.** A user
   who just submitted a reading sees their pending folio render below
   the form they just submitted. Mitigation: that's correct — the
   pending folio is the thing they made; the form is for the next
   one. Minor visual; acceptable.
7. **Wire format break for `bind` event** silently affecting any
   external consumer. Mitigation: the only consumer is the in-repo
   frontend; ship together. No external SSE consumers documented.
8. **Backfill correctness.** The migration promotes `folio_title` →
   `folio_motto` for completed v1 rows. v1 titles were 2–4 words ≤80
   chars, so the new motto length CHECK passes. Failed v1 rows had
   NULL folio_title; the backfill leaves them with NULL motto, which
   is fine — failed rows are never queried for motto.

## Out of Scope (Maybe Later)

- Multi-user "global concordance" view (find folios across users that
  echo yours).
- Hildegardian antiphon (a recurring incipit that opens every folio).
- Viriditas color register (a green undertone tied to the ascent
  phase).
- Self-quotation in interpretations (the oracle citing the seeker's
  earlier folios).
- "Sortes Apostolorum" mode: a fully randomized opening with no
  semantic retrieval — pure bibliomancy.
- Print-quality codex export (a single-PDF book of all your folios).
- A *book index* page (theme → folio list) generated from the codex.
- A Yeats-style 28-phase or Tarot-style 22-major-arcana alternative
  scaffold for the reading arc.
